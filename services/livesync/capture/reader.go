// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/log"
	"forgejo.org/modules/setting"

	"xorm.io/builder"
)

// MetaCursor is the livesync_meta entry holding the outbox reader's cursor:
// every outbox id at or below it has been processed or given up (see
// Batch.Cursor). The reader resumes from it after a restart.
const MetaCursor = "capture_cursor"

// Defaults for Config.
const (
	DefaultPollIntervalPostgres = 250 * time.Millisecond
	DefaultPollIntervalMySQL    = 100 * time.Millisecond
	DefaultHoleTimeout          = 30 * time.Second
	DefaultSweepInterval        = 5 * time.Second
	DefaultBatchSize            = 1000
)

// Config configures the outbox reader. Zero values mean the defaults.
type Config struct {
	// PollInterval is the polling safety net ([livesync] POLL_INTERVAL);
	// default 250 ms on PostgreSQL (which also has LISTEN), 100 ms on MySQL.
	PollInterval time.Duration
	// HoleTimeout is how long an id below the high-water mark is re-checked
	// before it is given up as rolled back ([livesync] HOLE_TIMEOUT, 30 s).
	HoleTimeout time.Duration
	// SweepInterval is how often the reader looks for rows at or below its
	// cursor: transactions that committed after their hole was given up.
	SweepInterval time.Duration
	// BatchSize bounds the rows per read and per Batch.
	BatchSize int
}

func (c Config) withDefaults() Config {
	if c.PollInterval <= 0 {
		c.PollInterval = DefaultPollIntervalMySQL
		if setting.Database.Type.IsPostgreSQL() {
			c.PollInterval = DefaultPollIntervalPostgres
		}
	}
	if c.HoleTimeout <= 0 {
		c.HoleTimeout = DefaultHoleTimeout
	}
	if c.SweepInterval <= 0 {
		c.SweepInterval = DefaultSweepInterval
	}
	if c.BatchSize <= 0 {
		c.BatchSize = DefaultBatchSize
	}
	return c
}

// Batch is a set of committed outbox rows handed to the Consumer, in
// ascending id order within the batch. Across batches ids are NOT globally
// ordered: a row of a transaction that committed late (a filled hole) comes
// after rows with higher ids. Consumers must not rely on id order between
// rows of different (table, row) pairs; they load the current state of each
// row anyway.
type Batch struct {
	Changes []livesync_model.Change
	// Cursor is the reader's cursor once this batch is processed: every id
	// at or below it is processed or given up. Commit persists it.
	Cursor int64
	// Seen is when the reader first saw the oldest change of the batch (or
	// the gap a late transaction's change fills); zero when unknown (rows
	// found by the sweep, deferred rows delivered again). For the
	// materialize lag metric.
	Seen time.Time

	committed bool
	deferred  map[int64]time.Time // change id -> not before
}

// Defer leaves the change with the given id in the outbox: Commit does not
// delete it, and the reader delivers it again, in a later batch, once until
// has passed (within its poll interval). The materializer uses it to
// coalesce bursts of changes to one row of a hot table: it defers one change
// of the (table, row) pair, which stands for all of them, and lets Commit
// delete the others. Deferred rows stay in the outbox, so a restart does not
// lose them (the reader's sweep finds them).
func (b *Batch) Defer(id int64, until time.Time) {
	if b.deferred == nil {
		b.deferred = map[int64]time.Time{}
	}
	b.deferred[id] = until
}

// Commit deletes the batch's rows from the outbox (the deferred ones are
// kept and marked Deferred) and stores Cursor under
// MetaCursor. A consumer that writes its results in a database transaction
// calls Commit with that transaction's context, so that processing and
// acknowledging are atomic; otherwise the reader calls it after Consume
// returns nil. It is idempotent.
func (b *Batch) Commit(ctx context.Context) error {
	if b.committed {
		return nil
	}
	ids := make([]int64, 0, len(b.Changes))
	for _, c := range b.Changes {
		if _, ok := b.deferred[c.ID]; !ok {
			ids = append(ids, c.ID)
		}
	}
	const chunk = 500
	for start := 0; start < len(ids); start += chunk {
		end := min(start+chunk, len(ids))
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		if _, err := e.In("id", ids[start:end]).Delete(&livesync_model.Change{}); err != nil {
			return fmt.Errorf("livesync: delete processed outbox rows: %w", err)
		}
	}
	if len(b.deferred) > 0 {
		// Marked, so that the idempotency layer (B7) does not wait for
		// rows the consumer has handled by postponing them.
		deferred := make([]int64, 0, len(b.deferred))
		for id := range b.deferred {
			deferred = append(deferred, id)
		}
		slices.Sort(deferred)
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		if _, err := e.In("id", deferred).Cols("deferred").Update(&livesync_model.Change{Deferred: true}); err != nil {
			return fmt.Errorf("livesync: mark deferred outbox rows: %w", err)
		}
	}
	if err := livesync_model.SetMeta(ctx, MetaCursor, strconv.FormatInt(b.Cursor, 10)); err != nil {
		return err
	}
	b.committed = true
	return nil
}

// Consumer processes the outbox. The materializer (B3) is the real one.
type Consumer interface {
	// Consume processes b. Returning an error makes the reader retry the
	// same rows later (with backoff). A crash after processing and before
	// Commit redelivers the batch after the restart, so processing must be
	// idempotent.
	Consume(ctx context.Context, b *Batch) error
}

// Reader reads committed outbox rows above its cursor, tracks holes below
// its high-water mark until HoleTimeout, and hands batches to a Consumer.
type Reader struct {
	cfg      Config
	consumer Consumer
	bell     *doorbell

	cursor    int64 // every id <= cursor is processed or given up
	high      int64 // highest id seen
	holes     holes // unseen ids in (cursor, high]
	lastSweep time.Time
	// deferred holds the rows the consumer deferred (Batch.Defer), with the
	// time before which they must not be delivered again. They stay in the
	// outbox, at or below high: the hole re-check (above the cursor) and the
	// sweep (at or below it) skip them until they are due.
	deferred map[int64]time.Time
	cycles   atomic.Int64 // cycles run (tests)

	done chan struct{}
}

// Start loads the cursor, hooks the doorbell up and runs the reader in the
// background until ctx is done (Wait waits for that). The capture triggers
// must be installed (Ensure).
func Start(ctx context.Context, cfg Config, consumer Consumer) (*Reader, error) {
	r := &Reader{
		cfg:       cfg.withDefaults(),
		consumer:  consumer,
		bell:      newDoorbell(),
		lastSweep: time.Now(),
		deferred:  map[int64]time.Time{},
		done:      make(chan struct{}),
	}
	if err := r.loadCursor(ctx); err != nil {
		return nil, err
	}
	if !setting.Database.Type.IsPostgreSQL() {
		// PostgreSQL rings through LISTEN/NOTIFY, for this instance's
		// commits too; elsewhere the master engine is observed.
		master, err := livesync_model.MasterXORMEngine()
		if err != nil {
			return nil, err
		}
		observeCommits(master)
	}
	subscribe(r.bell)
	if setting.Database.Type.IsPostgreSQL() {
		schema, err := CurrentSchema(ctx)
		if err != nil {
			unsubscribe(r.bell)
			return nil, err
		}
		go Listen(ctx, pgNotifyChannel, schema, r.bell.ring)
	}
	go r.run(ctx)
	return r, nil
}

// Wait blocks until the reader has stopped (its context is done) or timeout
// elapses, and reports whether it stopped.
func (r *Reader) Wait(timeout time.Duration) bool {
	select {
	case <-r.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (r *Reader) loadCursor(ctx context.Context) error {
	v, ok, err := livesync_model.GetMeta(ctx, MetaCursor)
	if err != nil {
		return err
	}
	if ok {
		if r.cursor, err = strconv.ParseInt(v, 10, 64); err != nil {
			return fmt.Errorf("livesync_meta %s is %q, not a number", MetaCursor, v)
		}
	}
	// The outbox was recreated or truncated (its ids restarted) if the last
	// id it assigned is below the cursor: resume from its start, otherwise
	// new rows (ids <= cursor) would only be found by the sweep. The
	// sequence / AUTO_INCREMENT counter tells this even when the outbox is
	// empty, which it normally is right after being recreated.
	last, err := LastAssignedID(ctx)
	if err != nil {
		return fmt.Errorf("livesync: read the outbox id counter: %w", err)
	}
	if last < r.cursor {
		log.Warn("livesync: outbox ids restarted (last assigned id %d < cursor %d); reading it from the start", last, r.cursor)
		r.cursor = 0
	}
	r.high = r.cursor
	return nil
}

// autoIncrementRe finds the counter in SHOW CREATE TABLE output.
var autoIncrementRe = regexp.MustCompile(`(?i)\bAUTO_INCREMENT=(\d+)`)

// LastAssignedID returns the highest id the outbox has handed out so far
// (0 if none), from its id counter rather than from its rows, which are
// deleted once processed. Ids are assigned when a trigger inserts the row,
// i.e. inside the writing transaction: every outbox row of a transaction that
// starts after a call has a higher id, and every row of a transaction that
// committed before a call has an id at or below its result (the idempotency
// layer, B7, brackets a write's rows this way).
func LastAssignedID(ctx context.Context) (int64, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return 0, err
	}
	table := livesync_model.Change{}.TableName()
	var last int64
	switch {
	case setting.Database.Type.IsPostgreSQL():
		query, err := PositionQuery(ctx)
		if err != nil {
			return 0, err
		}
		if _, err := e.SQL("SELECT " + query).Get(&last); err != nil {
			return 0, err
		}
	case setting.Database.Type.IsMySQL():
		// SHOW CREATE TABLE reports the live AUTO_INCREMENT counter (the
		// next id; omitted while it is 1); information_schema.tables may
		// serve a cached value (information_schema_stats_expiry).
		var name, ddl string
		if _, err := e.SQL("SHOW CREATE TABLE "+mysqlQuote(table)).Get(&name, &ddl); err != nil {
			return 0, err
		}
		if m := autoIncrementRe.FindStringSubmatch(ddl); m != nil {
			next, err := strconv.ParseInt(m[1], 10, 64)
			if err != nil {
				return 0, err
			}
			last = next - 1
		}
	default:
		// SQLite (unit tests): the AUTOINCREMENT counter if there is one,
		// else the highest id present.
		if _, err := e.SQL("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ?), 0), COALESCE((SELECT MAX(id) FROM "+table+"), 0))", table).Get(&last); err != nil {
			return 0, err
		}
	}
	return last, nil
}

// outboxSequence caches the name of the outbox id's sequence on
// PostgreSQL, per database and schema.
var outboxSequence struct {
	sync.Mutex
	key, name string
}

// PositionQuery returns, on PostgreSQL, a scalar subquery (parenthesised)
// whose value is LastAssignedID, so that a statement can record the outbox
// position without a round trip of its own; "" on other databases. The
// sequence's name is looked up once.
func PositionQuery(ctx context.Context) (string, error) {
	if !setting.Database.Type.IsPostgreSQL() {
		return "", nil
	}
	key := setting.Database.Host + "/" + setting.Database.Name + "/" + setting.Database.Schema
	outboxSequence.Lock()
	defer outboxSequence.Unlock()
	if outboxSequence.key != key || outboxSequence.name == "" {
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return "", err
		}
		table := livesync_model.Change{}.TableName()
		var seq string
		if _, err := e.SQL("SELECT COALESCE(pg_get_serial_sequence(?, 'id'), '')", table).Get(&seq); err != nil {
			return "", err
		}
		if seq == "" {
			return "", fmt.Errorf("%s.id has no sequence", table)
		}
		outboxSequence.key, outboxSequence.name = key, seq
	}
	// The id column's sequence (quoted and schema-qualified by
	// pg_get_serial_sequence); last_value is the last id handed out once
	// is_called, the next one before. Not transactional, which is what is
	// wanted here.
	return "(SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM " + outboxSequence.name + ")", nil
}

// minCycleGap is the shortest time between the starts of two reader cycles.
// Under write traffic the doorbell rings for every commit (on MySQL for
// every DML statement); rings that arrive within the gap are merged into one
// cycle, so the reader runs at most 1/minCycleGap cycles per second however
// busy the database is, and an idle reader still reacts at once.
const minCycleGap = 5 * time.Millisecond

func (r *Reader) run(ctx context.Context) {
	defer close(r.done)
	defer unsubscribe(r.bell)
	ticker := time.NewTicker(r.cfg.PollInterval)
	defer ticker.Stop()
	const minBackoff, maxBackoff = 100 * time.Millisecond, 10 * time.Second
	backoff := minBackoff
	var lastStart time.Time
	for {
		if wait := minCycleGap - time.Since(lastStart); wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			// This cycle covers every ring so far.
			select {
			case <-r.bell.c:
			default:
			}
		}
		lastStart = time.Now()
		r.cycles.Add(1)
		if err := r.cycle(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error("livesync: outbox reader: %v; retrying in %s", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = minBackoff
		select {
		case <-ctx.Done():
			return
		case <-r.bell.c:
		case <-ticker.C:
		}
	}
}

// cycle re-checks the holes, gives up expired ones, reads everything new and,
// every SweepInterval, picks up rows that committed after their hole was
// given up.
func (r *Reader) cycle(ctx context.Context) error {
	now := time.Now()
	if err := r.recheckHoles(ctx); err != nil {
		return err
	}
	if n := r.holes.expire(now.Add(-r.cfg.HoleTimeout)); n > 0 {
		log.Debug("livesync: outbox reader gave up %d id(s) after %s (rolled back?); %d still open", n, r.cfg.HoleTimeout, r.holes.count())
		r.cursor = r.cursorFor(&r.holes, r.high)
	}
	for {
		n, err := r.readNew(ctx, now)
		if err != nil {
			return err
		}
		if n < r.cfg.BatchSize {
			break
		}
	}
	if now.Sub(r.lastSweep) >= r.cfg.SweepInterval || r.deferredDue(now) {
		if err := r.sweep(ctx); err != nil {
			return err
		}
		r.lastSweep = now
	}
	return nil
}

// cursorFor is the cursor implied by a hole set and high-water mark.
func (r *Reader) cursorFor(h *holes, high int64) int64 {
	if lo, ok := h.min(); ok {
		return lo - 1
	}
	return high
}

func (r *Reader) find(ctx context.Context, cond builder.Cond) ([]livesync_model.Change, error) {
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]livesync_model.Change, 0, 16)
	if err := e.Where(cond).OrderBy("id").Limit(r.cfg.BatchSize).Find(&rows); err != nil {
		return nil, fmt.Errorf("read outbox: %w", err)
	}
	return rows, nil
}

// readNew reads one batch of rows above the high-water mark; ids skipped
// over become holes.
func (r *Reader) readNew(ctx context.Context, now time.Time) (int, error) {
	rows, err := r.find(ctx, builder.Gt{"id": r.high})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	// New holes all lie above the existing ones; they are added once the
	// batch is delivered.
	var gaps [][2]int64
	high := r.high
	for _, c := range rows {
		if c.ID > high+1 {
			gaps = append(gaps, [2]int64{high + 1, c.ID - 1})
		}
		high = c.ID
	}
	cursor := high
	if lo, ok := r.holes.min(); ok {
		cursor = lo - 1
	} else if len(gaps) > 0 {
		cursor = gaps[0][0] - 1
	}
	if err := r.deliver(ctx, rows, cursor, now); err != nil {
		return 0, err
	}
	for _, g := range gaps {
		r.holes.add(g[0], g[1], now)
	}
	// add may have given up the oldest holes (maxHoleRanges): the cursor
	// can only move up from the delivered one.
	r.high = high
	r.cursor = r.cursorFor(&r.holes, high)
	return len(rows), nil
}

// recheckHoles delivers the rows of holes that have been filled since. Every
// row with cursor < id <= high is one: rows the reader delivered are deleted
// before it advances, and the ids given up so far lie at or below the
// cursor. So one indexed range scan finds them all, whatever the number of
// holes.
//
// Rows the consumer deferred also lie in that range; they are skipped until
// they are due, which is why the scan pages by id instead of re-reading from
// the cursor.
func (r *Reader) recheckHoles(ctx context.Context) error {
	for after := r.cursor; after < r.high; {
		rows, err := r.find(ctx, builder.And(builder.Gt{"id": after}, builder.Lte{"id": r.high}))
		if err != nil || len(rows) == 0 {
			return err
		}
		after = rows[len(rows)-1].ID
		full := len(rows) == r.cfg.BatchSize
		if rows = r.due(rows, time.Now()); len(rows) > 0 {
			var seen time.Time
			next := r.holes.clone()
			for _, c := range rows {
				if i := next.index(c.ID); i >= 0 && (seen.IsZero() || next.r[i].since.Before(seen)) {
					seen = next.r[i].since
				}
				next.remove(c.ID)
			}
			cursor := r.cursorFor(&next, r.high)
			if err := r.deliver(ctx, rows, cursor, seen); err != nil {
				return err
			}
			r.holes, r.cursor = next, cursor
		}
		if !full {
			return nil
		}
	}
	return nil
}

// sweep delivers rows at or below the cursor: transactions that committed
// after their hole was given up. Processed rows are deleted, so normally
// there are none.
//
// It also delivers the deferred rows at or below the cursor that are due.
func (r *Reader) sweep(ctx context.Context) error {
	for after := int64(0); ; {
		rows, err := r.find(ctx, builder.And(builder.Gt{"id": after}, builder.Lte{"id": r.cursor}))
		if err != nil || len(rows) == 0 {
			return err
		}
		after = rows[len(rows)-1].ID
		full := len(rows) == r.cfg.BatchSize
		if rows = r.due(rows, time.Now()); len(rows) > 0 {
			log.Debug("livesync: outbox reader found %d late or deferred row(s) at or below its cursor %d", len(rows), r.cursor)
			if err := r.deliver(ctx, rows, r.cursor, time.Time{}); err != nil {
				return err
			}
		}
		if !full {
			return nil
		}
	}
}

// due drops the rows that are deferred until after now.
func (r *Reader) due(rows []livesync_model.Change, now time.Time) []livesync_model.Change {
	if len(r.deferred) == 0 {
		return rows
	}
	res := rows[:0:0]
	for _, c := range rows {
		if until, ok := r.deferred[c.ID]; !ok || !until.After(now) {
			res = append(res, c)
		}
	}
	return res
}

// deferredDue reports whether a deferred row is due.
func (r *Reader) deferredDue(now time.Time) bool {
	for _, until := range r.deferred {
		if !until.After(now) {
			return true
		}
	}
	return false
}

// deliver hands rows to the consumer and commits the batch if the consumer
// did not.
func (r *Reader) deliver(ctx context.Context, rows []livesync_model.Change, cursor int64, seen time.Time) error {
	b := &Batch{Changes: rows, Cursor: cursor, Seen: seen}
	if err := r.consumer.Consume(ctx, b); err != nil {
		return fmt.Errorf("consume %d change(s): %w", len(rows), err)
	}
	if !b.committed {
		if err := WithQuietTx(ctx, b.Commit); err != nil {
			return err
		}
	}
	for _, c := range rows {
		delete(r.deferred, c.ID)
	}
	maps.Copy(r.deferred, b.deferred)
	return nil
}
