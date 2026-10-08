// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package materialize turns captured row changes into sync log entries
// (PLAN §4.4): it is the outbox reader's consumer on the instance that holds
// the sync log writer lease. For each batch it coalesces the changes by
// (table, row), loads the rows' current state through Forgejo's typed
// models, builds the viewer-independent protocol DTOs (markdown rendered by
// the markup service), routes them to their sync group with the entity index
// (livesync_entity, which also routes deletes), skips payloads that did not
// change, and appends the entries — all in one transaction with the
// acknowledgement of the outbox rows (capture.Batch.Commit), so the log and
// the capture cursor never disagree.
//
// It also consumes the capture schema epochs (re-bootstrap markers, see
// HandleEpochs) and backfills the entity index for rows that existed before
// livesync was installed (BackfillStep).
package materialize

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/metrics"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
)

// writerTxTimeout bounds one materializer transaction.
const writerTxTimeout = time.Minute

// Config configures a Materializer.
type Config struct {
	// HotWindow is the minimum time between two emissions of the same row
	// of a hot table ([livesync] HOT_COALESCE); 0 disables the coalescing.
	HotWindow time.Duration
	// Consumed, if not nil, is called after every outbox batch the
	// materializer committed (its rows are deleted from the outbox and its
	// entries appended in that transaction). The idempotency layer (B7)
	// waits for a write's outbox rows to be consumed with it.
	Consumed func()
}

// Materializer is the capture.Consumer that writes the sync log. Its
// methods are safe for concurrent use (they serialise on a mutex): the
// reader calls Consume while the writer loop runs HandleEpochs and
// BackfillStep.
type Materializer struct {
	writer   *synclog.Writer
	stop     func()
	consumed func()

	mu  sync.Mutex
	hot hotLimiter
	// failures counts the consecutive Consume calls that failed: the next
	// one materializes its batch row by row (isolate).
	failures int
	// backfill holds, per tracked table, the last id whose entity index
	// row the backfill wrote, or backfillDone; walk is the mode of the
	// tables whose backfill is not the initial one (indexRepair after a
	// re-bootstrap marker, indexPerm for a permission walk).
	backfill map[string]int64
	walk     map[string]indexWrite
}

// New returns a materializer that appends with w. stop is called when w
// turns out not to be the writer any more (another instance took over):
// the caller must then stop the reader and give up the lease.
func New(cfg Config, w *synclog.Writer, stop func()) *Materializer {
	return &Materializer{writer: w, stop: stop, consumed: cfg.Consumed, hot: newHotLimiter(cfg.HotWindow)}
}

// Prepare loads the backfill progress and handles schema epochs that moved
// while no materializer ran. Call it before starting the reader.
func (m *Materializer) Prepare(ctx context.Context) error {
	m.mu.Lock()
	err := m.loadBackfill(ctx)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	return m.HandleEpochs(ctx)
}

// inWriterTx runs fn in a quiet transaction (its COMMIT does not ring the
// outbox reader's doorbell) and stops the materializer when the fencing
// check of synclog.Writer.Append, which fn must call, says another instance
// is the writer now.
//
// The transaction does not end when ctx is cancelled (shutdown, lease
// lost): database/sql would roll it back under the running statements, which
// then fail noisily. It runs to its end (bounded by writerTxTimeout) and
// the caller notices ctx afterwards; the fencing token keeps a writer that
// lost its lease from doing harm meanwhile.
func (m *Materializer) inWriterTx(ctx context.Context, fn func(ctx context.Context) error) error {
	txCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), writerTxTimeout)
	defer cancel()
	err := capture.WithQuietTx(txCtx, fn)
	if errors.Is(err, synclog.ErrNotWriter) {
		m.stop()
	}
	return err
}

// Consume implements capture.Consumer.
func (m *Materializer) Consume(ctx context.Context, b *capture.Batch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	rows := coalesce(b.Changes)
	work := rows[:0]
	var hot []rowKey
	for _, r := range rows {
		if specs[r.key.tbl] == nil {
			continue // not (or no longer) tracked: acknowledged, nothing to emit
		}
		if hotTables[r.key.tbl] {
			if ok, until := m.hot.admit(r.key, now); !ok {
				// The newest change stands for all of the row's changes
				// in this batch; Commit deletes the others.
				b.Defer(r.last(), until)
				continue
			}
			hot = append(hot, r.key)
		}
		work = append(work, r)
	}
	var appended int
	var err error
	if m.failures == 0 {
		appended, err = m.write(ctx, work, b, false, nil)
		if errors.Is(err, errRenderBudget) {
			log.Info("livesync: the markdown of a batch of %d rows took longer than %s to render; materializing them one by one", len(work), txRenderBudget)
			appended, err = m.isolate(ctx, work, b)
		}
	} else {
		// The batch failed before: one row of it may be the cause.
		appended, err = m.isolate(ctx, work, b)
	}
	if err != nil {
		m.failures++
		return err
	}
	m.failures = 0
	metrics.Materialized.Add(float64(b.Consumed())) // deferred rows count when they are consumed
	metrics.LogEntries.Add(float64(appended))
	if !b.Seen.IsZero() {
		metrics.MaterializeLag.Observe(time.Since(b.Seen).Seconds())
	}
	for _, k := range hot {
		m.hot.done(k, now)
	}
	m.hot.prune(now)
	if m.consumed != nil {
		m.consumed()
	}
	return nil
}

// write materializes rows in one writer transaction and appends their
// entries; with b it also acknowledges b's outbox rows in it (and bumps the
// schema epochs of the tables in lost, see isolate). lenient: the
// transaction's render budget, once used up, leaves the remaining bodies
// without HTML (BodyTruncated) instead of failing with errRenderBudget. It
// returns the number of entries appended.
func (m *Materializer) write(ctx context.Context, rows []rowChanges, b *capture.Batch, lenient bool, lost []string) (int, error) {
	appended := 0
	err := m.inWriterTx(ctx, func(ctx context.Context) error {
		entries, plan, err := m.materialize(ctx, rows, lenient)
		if err != nil {
			return err
		}
		if entries, err = plan.withPermissionEpoch(ctx, entries); err != nil {
			return err
		}
		appended = len(entries)
		first, err := m.writer.Append(ctx, entries)
		if err != nil {
			return err
		}
		if err := plan.apply(ctx, first); err != nil {
			return err
		}
		if b == nil {
			return nil
		}
		for _, table := range lost {
			if _, err := capture.BumpEpoch(ctx, table); err != nil {
				return err
			}
		}
		return b.Commit(ctx)
	})
	return appended, err
}

// isolate materializes a batch that failed as a whole (or whose markdown
// took too long to render in one transaction): every row in a writer
// transaction of its own, with a render budget of its own, then the
// acknowledgement of the batch. A row that fails alone while the database
// works (an empty writer transaction succeeds) is tried once more and then
// skipped: one row that cannot be written (a DTO the database refuses, a
// row whose rendering cannot finish) must not stop the sync log for
// everyone, and retrying the whole batch forever would (backend audit).
// The skipped row's change is lost, so its table's schema epoch is bumped
// in the acknowledging transaction: HandleEpochs then writes re-bootstrap
// markers for its models (clients load them again from the tables) and
// repairs the table's entity index, exactly as for changes lost while a
// capture trigger was missing. Any other failure (the database is
// unreachable, this instance is no longer the writer, ctx is done) is
// returned and the reader retries the batch later; rows already written
// are written again then, which their unchanged index hashes turn into
// no entries.
func (m *Materializer) isolate(ctx context.Context, rows []rowChanges, b *capture.Batch) (int, error) {
	appended := 0
	var lost []string
	for _, r := range rows {
		n, err := m.write(ctx, []rowChanges{r}, nil, true, nil)
		if err != nil && !errors.Is(err, synclog.ErrNotWriter) && ctx.Err() == nil {
			if _, probe := m.write(ctx, nil, nil, true, nil); probe != nil {
				return appended, err // the database, not the row
			}
			if n, err = m.write(ctx, []rowChanges{r}, nil, true, nil); err != nil {
				log.Error("livesync: skipping the change of %s %d, which cannot be written to the sync log: %v; clients re-bootstrap the table's models", r.key.tbl, r.key.id, err)
				if !slices.Contains(lost, r.key.tbl) {
					lost = append(lost, r.key.tbl)
				}
				continue
			}
		}
		if err != nil {
			return appended, err
		}
		appended += n
	}
	n, err := m.write(ctx, nil, b, true, lost)
	return appended + n, err
}

// txRenderBudget bounds the time a writer transaction spends rendering
// markdown (writerTxTimeout bounds the whole transaction). A variable so
// that tests can shorten it.
var txRenderBudget = 30 * time.Second

// indexPlan collects the entity index changes of a transaction; upserts
// learn their sync id once the entries are appended.
type indexPlan struct {
	upserts []livesync_model.Entity
	entry   []int // index into the entries of each upsert
	deletes []indexKey
	// permIndex are rows of permission tables whose new permission state
	// must be stored although no entry is written for them (nothing
	// visible changed, e.g. a user made admin, or the DTO could not be
	// built): the perm column of their index row is updated, and a missing
	// index row is inserted (group and unit, no hash).
	permIndex []livesync_model.Entity
	// perm collects the subjects of the permission states that changed.
	perm permSubjects
}

func (p *indexPlan) apply(ctx context.Context, first int64) error {
	for i := range p.upserts {
		p.upserts[i].LastSyncID = first + int64(p.entry[i])
	}
	if err := writeIndex(ctx, p.upserts, indexUpsert); err != nil {
		return err
	}
	if err := writeIndex(ctx, p.permIndex, indexPerm); err != nil {
		return err
	}
	return deleteIndex(ctx, p.deletes)
}

// withPermissionEpoch puts the transaction's permission epoch, if any
// permission state changed, in front of its entries (see perm.go).
func (p *indexPlan) withPermissionEpoch(ctx context.Context, entries []synclog.Entry) ([]synclog.Entry, error) {
	ch, ok, err := p.perm.change(ctx)
	if err != nil || !ok {
		return entries, err
	}
	e, err := permEntry(ch)
	if err != nil {
		return nil, err
	}
	for i := range p.entry {
		p.entry[i]++
	}
	return append([]synclog.Entry{e}, entries...), nil
}

// maxDependentRounds bounds the dependents cascade of one batch (review →
// comment → attachment/reaction/revision is two rounds).
const maxDependentRounds = 4

// materialize builds the log entries and index changes for rows, and for
// the rows that depend on a row whose group changed (spec.dependents). Its
// markdown rendering is bounded by txRenderBudget (see write for lenient).
func (m *Materializer) materialize(ctx context.Context, rows []rowChanges, lenient bool) ([]synclog.Entry, *indexPlan, error) {
	plan := &indexPlan{}
	if len(rows) == 0 {
		return nil, plan, nil
	}
	l := newLoader()
	defer l.close()
	l.budget, l.strict = txRenderBudget, !lenient
	keys := make([]rowKey, 0, len(rows))
	changed := map[rowKey]rowChanges{}
	for _, r := range rows {
		keys = append(keys, r.key)
		if r.inserted || r.updated {
			changed[r.key] = r
		}
	}
	done := map[rowKey]bool{}
	var entries []synclog.Entry
	for round := 0; len(keys) > 0; round++ {
		for _, k := range keys {
			done[k] = true
		}
		moved, err := m.materializeRows(ctx, l, keys, changed, &entries, plan)
		if err != nil {
			return nil, nil, err
		}
		if round == maxDependentRounds {
			break
		}
		if keys, err = dependentRows(ctx, moved, done); err != nil {
			return nil, nil, err
		}
	}
	return entries, plan, nil
}

// dependentRows returns the rows, not yet materialized in this batch, that
// depend on the moved rows (table → ids).
func dependentRows(ctx context.Context, moved map[string][]int64, done map[rowKey]bool) ([]rowKey, error) {
	var res []rowKey
	for _, tbl := range sortedKeys(moved) {
		for _, dep := range specs[tbl].dependents {
			ids := moved[tbl]
			for start := 0; start < len(ids); start += inChunk {
				var found []int64
				if err := db.GetEngine(ctx).Table(dep.table).Cols("id").In(dep.column, ids[start:min(start+inChunk, len(ids))]).OrderBy("id").Find(&found); err != nil {
					return nil, fmt.Errorf("livesync: find the %s rows of moved %s rows: %w", dep.table, tbl, err)
				}
				for _, id := range found {
					if k := (rowKey{dep.table, id}); !done[k] {
						done[k] = true
						res = append(res, k)
					}
				}
			}
		}
	}
	return res, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// materializeRows appends the entries and index changes for rows (in
// order) and returns the rows whose main entity changed group (including
// appearing in or leaving every group), by table. changed has the rows with
// an insert or an update among their changes.
func (m *Materializer) materializeRows(ctx context.Context, l *loader, rows []rowKey, changed map[rowKey]rowChanges, entries *[]synclog.Entry, plan *indexPlan) (map[string][]int64, error) {
	// Group the rows by table, keeping the batch order of tables.
	byTable := map[string][]int64{}
	var tables []string
	for _, r := range rows {
		if _, ok := byTable[r.tbl]; !ok {
			tables = append(tables, r.tbl)
		}
		byTable[r.tbl] = append(byTable[r.tbl], r.id)
	}
	states := map[rowKey][]entity{}
	old := map[indexKey]*livesync_model.Entity{}
	for _, tbl := range tables {
		s := specs[tbl]
		loaded, err := s.load(ctx, l, byTable[tbl], true)
		if err != nil {
			return nil, fmt.Errorf("livesync: load %s rows: %w", tbl, err)
		}
		for id, ents := range loaded {
			states[rowKey{tbl, id}] = ents
		}
		for _, key := range s.keys {
			idx, err := loadIndex(ctx, key, byTable[tbl])
			if err != nil {
				return nil, err
			}
			for id, e := range idx {
				old[indexKey{key, id}] = e
			}
		}
	}

	moved := map[string][]int64{}
	for _, r := range rows {
		s := specs[r.tbl]
		ents := states[r]
		for i, key := range s.keys {
			var cur *entity
			if ents != nil && ents[i].group != "" {
				cur = &ents[i]
			}
			o := old[indexKey{key, r.id}]
			// The row's permission state (main entity of a permission
			// table only): a change is a permission epoch for the old and
			// the new subjects, whatever else happens to the entity.
			var curPerm string
			permChanged := false
			if i == 0 && s.perm {
				if cur != nil {
					curPerm = cur.perm
				}
				c := changed[r]
				permChanged = plan.perm.transition(r, o, curPerm, permFlags{
					inserted: c.inserted, updated: c.updated, touch: s.permTouch,
					derived: s.permDerived, backfilled: m.backfillComplete(r.tbl),
				})
			}
			// keepPerm records a changed state for a row whose index row
			// is otherwise kept as it is (or not written).
			keepPerm := func() {
				if permChanged {
					plan.permIndex = append(plan.permIndex, livesync_model.Entity{Tbl: key, RowID: r.id, Grp: cur.group, Unit: string(cur.unit), Perm: curPerm})
				}
			}
			if i == 0 {
				var oldGroup, curGroup string
				if o != nil {
					oldGroup = o.Grp
				}
				if cur != nil {
					curGroup = cur.group
				}
				if oldGroup != curGroup {
					moved[r.tbl] = append(moved[r.tbl], r.id)
				}
			}
			model := s.models[i]
			switch {
			case cur == nil && o == nil:
				// Never emitted (or not since it left every group), and
				// not indexed: no client can hold it from the log. One
				// that has it from a bootstrap made before the table's
				// index backfill completed could; bootstraps must wait for
				// it (B6, see the entity index backfill). (A permission
				// row's epoch, if it needs one, was decided above.)
			case cur == nil:
				*entries = append(*entries, synclog.Entry{Group: o.Grp, Unit: protocol.Unit(o.Unit), Model: model, EntityID: r.id, Op: protocol.OpDelete})
				plan.deletes = append(plan.deletes, indexKey{key, r.id})
			default:
				hash, err := "", cur.err
				if err == nil {
					hash, err = cur.changeHash(ctx, l)
				}
				if err != nil {
					log.Error("livesync: skipping a change of %s %d: %v", r.tbl, r.id, err)
					keepPerm()
					continue
				}
				if o != nil && o.Grp == cur.group && o.Unit == string(cur.unit) && o.Hash == hash {
					keepPerm()
					continue // nothing visible changed
				}
				payload, err := cur.payload(ctx, l)
				if errors.Is(err, errRenderBudget) {
					return nil, err
				}
				if err != nil {
					log.Error("livesync: skipping a change of %s %d: %v", r.tbl, r.id, err)
					keepPerm()
					continue
				}
				if o != nil && (o.Grp != cur.group || o.Unit != string(cur.unit)) {
					// Moved to another group, or now needs another unit:
					// gone for the readers of the old place (members of
					// the new one get the upsert right after).
					*entries = append(*entries, synclog.Entry{Group: o.Grp, Unit: protocol.Unit(o.Unit), Model: model, EntityID: r.id, Op: protocol.OpDelete})
				}
				plan.upserts = append(plan.upserts, livesync_model.Entity{Tbl: key, RowID: r.id, Grp: cur.group, Unit: string(cur.unit), Hash: hash, Perm: curPerm})
				plan.entry = append(plan.entry, len(*entries))
				*entries = append(*entries, synclog.Entry{
					Group: cur.group, Unit: cur.unit, Model: cur.model, EntityID: r.id,
					Op: protocol.OpUpsert, Payload: payload, SchemaVer: cur.schema,
				})
			}
		}
	}
	return moved, nil
}
