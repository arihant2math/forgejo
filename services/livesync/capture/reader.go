// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"forgejo.org/models/db"
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

	committed bool
}

// Commit deletes the batch's rows from the outbox and stores Cursor under
// MetaCursor. A consumer that writes its results in a database transaction
// calls Commit with that transaction's context, so that processing and
// acknowledging are atomic; otherwise the reader calls it after Consume
// returns nil. It is idempotent.
func (b *Batch) Commit(ctx context.Context) error {
	if b.committed {
		return nil
	}
	const chunk = 500
	for start := 0; start < len(b.Changes); start += chunk {
		end := min(start+chunk, len(b.Changes))
		ids := make([]int64, 0, end-start)
		for _, c := range b.Changes[start:end] {
			ids = append(ids, c.ID)
		}
		e, err := livesync_model.MasterEngine(ctx)
		if err != nil {
			return err
		}
		if _, err := e.In("id", ids).Delete(&livesync_model.Change{}); err != nil {
			return fmt.Errorf("livesync: delete processed outbox rows: %w", err)
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
		done:      make(chan struct{}),
	}
	if err := r.loadCursor(ctx); err != nil {
		return nil, err
	}
	master, err := livesync_model.MasterXORMEngine()
	if err != nil {
		return nil, err
	}
	addCommitHook(master)
	subscribe(r.bell)
	if setting.Database.Type.IsPostgreSQL() {
		schema, err := currentSchema(ctx)
		if err != nil {
			unsubscribe(r.bell)
			return nil, err
		}
		go listenPostgres(ctx, schema, r.bell)
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
	// The outbox was recreated (its ids restarted) if it holds rows but none
	// above the cursor; resume from its start instead of skipping them.
	e, err := livesync_model.MasterEngine(ctx)
	if err != nil {
		return err
	}
	var maxID int64
	if _, err := e.SQL("SELECT COALESCE(MAX(id), 0) FROM " + livesync_model.Change{}.TableName()).Get(&maxID); err != nil {
		return fmt.Errorf("livesync: read outbox high-water mark: %w", err)
	}
	if maxID > 0 && maxID < r.cursor {
		log.Warn("livesync: outbox ids restarted (max id %d < cursor %d); reading it from the start", maxID, r.cursor)
		r.cursor = 0
	}
	r.high = r.cursor
	return nil
}

func (r *Reader) run(ctx context.Context) {
	defer close(r.done)
	defer unsubscribe(r.bell)
	ticker := time.NewTicker(r.cfg.PollInterval)
	defer ticker.Stop()
	const minBackoff, maxBackoff = 100 * time.Millisecond, 10 * time.Second
	backoff := minBackoff
	for {
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
	if now.Sub(r.lastSweep) >= r.cfg.SweepInterval {
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
	next := r.holes.clone()
	high := r.high
	for _, c := range rows {
		next.add(high+1, c.ID-1, now)
		high = c.ID
	}
	cursor := r.cursorFor(&next, high)
	if err := r.deliver(ctx, rows, cursor); err != nil {
		return 0, err
	}
	r.holes, r.high, r.cursor = next, high, cursor
	return len(rows), nil
}

// recheckHoles delivers the rows of holes that have been filled since.
func (r *Reader) recheckHoles(ctx context.Context) error {
	const rangesPerQuery = 64
	all := r.holes.ranges()
	for start := 0; start < len(all); start += rangesPerQuery {
		chunk := all[start:min(start+rangesPerQuery, len(all))]
		conds := make([]builder.Cond, 0, len(chunk))
		for _, rg := range chunk {
			conds = append(conds, builder.Between{Col: "id", LessVal: rg[0], MoreVal: rg[1]})
		}
		inRanges := builder.Or(conds...)
		after := int64(0)
		for {
			rows, err := r.find(ctx, builder.And(inRanges, builder.Gt{"id": after}))
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				break
			}
			after = rows[len(rows)-1].ID
			next := r.holes.clone()
			filled := rows[:0:0]
			for _, c := range rows {
				if next.contains(c.ID) {
					next.remove(c.ID)
					filled = append(filled, c)
				}
			}
			if len(filled) > 0 {
				cursor := r.cursorFor(&next, r.high)
				if err := r.deliver(ctx, filled, cursor); err != nil {
					return err
				}
				r.holes, r.cursor = next, cursor
			}
			if len(rows) < r.cfg.BatchSize {
				break
			}
		}
	}
	return nil
}

// sweep delivers rows at or below the cursor: transactions that committed
// after their hole was given up. Processed rows are deleted, so normally
// there are none.
func (r *Reader) sweep(ctx context.Context) error {
	for {
		rows, err := r.find(ctx, builder.Lte{"id": r.cursor})
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		log.Debug("livesync: outbox reader found %d late row(s) at or below its cursor %d", len(rows), r.cursor)
		if err := r.deliver(ctx, rows, r.cursor); err != nil {
			return err
		}
		if len(rows) < r.cfg.BatchSize {
			return nil
		}
	}
}

// deliver hands rows to the consumer and commits the batch if the consumer
// did not.
func (r *Reader) deliver(ctx context.Context, rows []livesync_model.Change, cursor int64) error {
	b := &Batch{Changes: rows, Cursor: cursor}
	if err := r.consumer.Consume(ctx, b); err != nil {
		return fmt.Errorf("consume %d change(s): %w", len(rows), err)
	}
	if !b.committed {
		if err := db.WithTx(ctx, b.Commit); err != nil {
			return err
		}
	}
	return nil
}
