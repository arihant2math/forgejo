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
	"sync"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/services/livesync/capture"
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
}

// Materializer is the capture.Consumer that writes the sync log. Its
// methods are safe for concurrent use (they serialise on a mutex): the
// reader calls Consume while the writer loop runs HandleEpochs and
// BackfillStep.
type Materializer struct {
	writer *synclog.Writer
	stop   func()

	mu  sync.Mutex
	hot hotLimiter
	// backfill holds, per tracked table, the last id whose entity index
	// row the backfill wrote, or backfillDone.
	backfill map[string]int64
}

// New returns a materializer that appends with w. stop is called when w
// turns out not to be the writer any more (another instance took over):
// the caller must then stop the reader and give up the lease.
func New(cfg Config, w *synclog.Writer, stop func()) *Materializer {
	return &Materializer{writer: w, stop: stop, hot: newHotLimiter(cfg.HotWindow)}
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
	err := m.inWriterTx(ctx, func(ctx context.Context) error {
		entries, plan, err := m.materialize(ctx, work)
		if err != nil {
			return err
		}
		first, err := m.writer.Append(ctx, entries)
		if err != nil {
			return err
		}
		if err := plan.apply(ctx, first); err != nil {
			return err
		}
		return b.Commit(ctx)
	})
	if err != nil {
		return err
	}
	for _, k := range hot {
		m.hot.done(k, now)
	}
	m.hot.prune(now)
	return nil
}

// indexPlan collects the entity index changes of a transaction; upserts
// learn their sync id once the entries are appended.
type indexPlan struct {
	upserts []livesync_model.Entity
	entry   []int // index into the entries of each upsert
	deletes []indexKey
}

func (p *indexPlan) apply(ctx context.Context, first int64) error {
	for i := range p.upserts {
		p.upserts[i].LastSyncID = first + int64(p.entry[i])
	}
	if err := writeIndex(ctx, p.upserts, true); err != nil {
		return err
	}
	return deleteIndex(ctx, p.deletes)
}

// materialize builds the log entries and index changes for rows.
func (m *Materializer) materialize(ctx context.Context, rows []rowChanges) ([]synclog.Entry, *indexPlan, error) {
	plan := &indexPlan{}
	if len(rows) == 0 {
		return nil, plan, nil
	}
	// Group the rows by table, keeping the batch order of tables.
	byTable := map[string][]int64{}
	var tables []string
	for _, r := range rows {
		if _, ok := byTable[r.key.tbl]; !ok {
			tables = append(tables, r.key.tbl)
		}
		byTable[r.key.tbl] = append(byTable[r.key.tbl], r.key.id)
	}
	l := newLoader()
	defer l.close()
	states := map[rowKey][]entity{}
	old := map[indexKey]*livesync_model.Entity{}
	for _, tbl := range tables {
		s := specs[tbl]
		loaded, err := s.load(ctx, l, byTable[tbl], true)
		if err != nil {
			return nil, nil, fmt.Errorf("livesync: load %s rows: %w", tbl, err)
		}
		for id, ents := range loaded {
			states[rowKey{tbl, id}] = ents
		}
		for _, key := range s.keys {
			idx, err := loadIndex(ctx, key, byTable[tbl])
			if err != nil {
				return nil, nil, err
			}
			for id, e := range idx {
				old[indexKey{key, id}] = e
			}
		}
	}

	var entries []synclog.Entry
	for _, r := range rows {
		s := specs[r.key.tbl]
		ents, exists := states[r.key]
		for i, key := range s.keys {
			var cur *entity
			if exists && ents[i].group != "" {
				cur = &ents[i]
			}
			o := old[indexKey{key, r.key.id}]
			model := s.models[i]
			switch {
			case cur == nil && o == nil:
				// Never emitted. If the row is gone and the index is not
				// complete for its table yet, a client may hold it from a
				// bootstrap: tell everyone (id only, no payload).
				if !exists && !m.backfillComplete(r.key.tbl) {
					entries = append(entries, synclog.Entry{Group: protocol.GroupAll, Model: model, EntityID: r.key.id, Op: protocol.OpDelete})
				}
			case cur == nil:
				entries = append(entries, synclog.Entry{Group: o.Grp, Unit: protocol.Unit(o.Unit), Model: model, EntityID: r.key.id, Op: protocol.OpDelete})
				plan.deletes = append(plan.deletes, indexKey{key, r.key.id})
			default:
				payload, hash, err := "", "", cur.err
				if err == nil {
					payload, hash, err = cur.payload()
				}
				if err != nil {
					log.Error("livesync: skipping a change of %s %d: %v", r.key.tbl, r.key.id, err)
					continue
				}
				if o != nil && o.Grp == cur.group && o.Unit == string(cur.unit) && o.Hash == hash {
					continue // nothing visible changed
				}
				if o != nil && o.Grp != cur.group {
					// Moved to another group: gone from the old one.
					entries = append(entries, synclog.Entry{Group: o.Grp, Unit: protocol.Unit(o.Unit), Model: model, EntityID: r.key.id, Op: protocol.OpDelete})
				}
				plan.upserts = append(plan.upserts, livesync_model.Entity{Tbl: key, RowID: r.key.id, Grp: cur.group, Unit: string(cur.unit), Hash: hash})
				plan.entry = append(plan.entry, len(entries))
				entries = append(entries, synclog.Entry{
					Group: cur.group, Unit: cur.unit, Model: cur.model, EntityID: r.key.id,
					Op: protocol.OpUpsert, Payload: payload, SchemaVer: cur.schema,
				})
			}
		}
	}
	return entries, plan, nil
}
