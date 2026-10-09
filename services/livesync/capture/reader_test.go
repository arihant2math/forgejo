// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package capture

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/cache"

	"code.forgejo.org/xorm/xorm"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The reader's logic on SQLite (unit tests only; livesync itself never runs
// there): outbox rows are inserted with explicit ids, which simulates
// transactions committing out of id order and rolled-back ids. The real
// triggers, transactions and LISTEN are covered by the TestLivesyncCapture*
// integration tests on PostgreSQL and MySQL.

type fakeConsumer struct {
	batches chan *Batch
	fail    atomic.Int32 // fail this many Consume calls
	inTx    bool         // call Commit inside a transaction
}

func (c *fakeConsumer) Consume(ctx context.Context, b *Batch) error {
	if c.fail.Load() > 0 {
		c.fail.Add(-1)
		return errors.New("injected failure")
	}
	if c.inTx {
		if err := db.WithTx(ctx, b.Commit); err != nil {
			return err
		}
	}
	c.batches <- b
	return nil
}

func (c *fakeConsumer) next(t *testing.T) *Batch {
	t.Helper()
	select {
	case b := <-c.batches:
		return b
	case <-time.After(10 * time.Second):
		t.Fatal("no batch delivered")
		return nil
	}
}

func (c *fakeConsumer) none(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case b := <-c.batches:
		t.Fatalf("unexpected batch %v", ids(b))
	case <-time.After(d):
	}
}

func ids(b *Batch) []int64 {
	var res []int64
	for _, c := range b.Changes {
		res = append(res, c.ID)
	}
	return res
}

func insertChange(t *testing.T, id int64) {
	t.Helper()
	// In a transaction: its COMMIT rings the in-process doorbell (the
	// statement alone does not, it writes a livesync_ table).
	require.NoError(t, db.WithTx(t.Context(), func(ctx context.Context) error {
		_, err := db.GetEngine(ctx).Exec("INSERT INTO livesync_change (id, tbl, row_id, op) VALUES (?, ?, ?, ?)", id, "issue", 100+id, livesync_model.OpUpdate)
		return err
	}))
}

func outboxIDs(t *testing.T) []int64 {
	t.Helper()
	var res []int64
	require.NoError(t, db.GetEngine(t.Context()).Table("livesync_change").Cols("id").OrderBy("id").Find(&res))
	return res
}

func storedCursor(t *testing.T) string {
	t.Helper()
	v, _, err := livesync_model.GetMeta(t.Context(), MetaCursor)
	require.NoError(t, err)
	return v
}

func resetOutbox(t *testing.T) {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	require.NoError(t, livesync_model.SyncTables(t.Context()))
	_, err := db.GetEngine(t.Context()).Exec("DELETE FROM livesync_change")
	require.NoError(t, err)
	_, err = db.GetEngine(t.Context()).Exec("DELETE FROM livesync_meta")
	require.NoError(t, err)
	setOutboxCounter(t, 0)
}

// setOutboxCounter sets the outbox's AUTOINCREMENT counter (the last id it
// assigned), as a recreated (0) or long-used outbox would have it.
func setOutboxCounter(t *testing.T, last int64) {
	t.Helper()
	_, err := db.GetEngine(t.Context()).Exec("DELETE FROM sqlite_sequence WHERE name = 'livesync_change'")
	require.NoError(t, err)
	if last > 0 {
		_, err = db.GetEngine(t.Context()).Exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('livesync_change', ?)", last)
		require.NoError(t, err)
	}
}

func startReader(t *testing.T, c Consumer) *Reader {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	r, err := Start(ctx, Config{
		PollInterval:  time.Hour, // only the commit hook wakes it up
		HoleTimeout:   300 * time.Millisecond,
		SweepInterval: 200 * time.Millisecond,
	}, c)
	require.NoError(t, err)
	t.Cleanup(func() {
		cancel()
		assert.True(t, r.Wait(5*time.Second))
	})
	return r
}

func TestReaderHoles(t *testing.T) {
	resetOutbox(t)
	c := &fakeConsumer{batches: make(chan *Batch, 16)}
	startReader(t, c)

	insertChange(t, 1)
	insertChange(t, 2)
	b := c.next(t)
	if len(b.Changes) == 1 { // the two inserts may wake the reader twice
		b2 := c.next(t)
		b.Changes = append(b.Changes, b2.Changes...)
		b.Cursor = b2.Cursor
	}
	assert.Equal(t, []int64{1, 2}, ids(b))
	assert.EqualValues(t, 2, b.Cursor)
	assert.Equal(t, livesync_model.Change{ID: 1, Tbl: "issue", RowID: 101, Op: "U"}, b.Changes[0])

	// 3 and 4 are still in flight when 5 commits: 5 is delivered at once,
	// the cursor stays below the holes.
	insertChange(t, 5)
	b = c.next(t)
	assert.Equal(t, []int64{5}, ids(b))
	assert.EqualValues(t, 2, b.Cursor)

	// 3 commits late: the hole is filled.
	insertChange(t, 3)
	b = c.next(t)
	assert.Equal(t, []int64{3}, ids(b))
	assert.EqualValues(t, 3, b.Cursor)

	// 4 never commits (rolled back): given up after HoleTimeout, the cursor
	// moves past it with the next batch.
	time.Sleep(400 * time.Millisecond)
	insertChange(t, 6)
	b = c.next(t)
	assert.Equal(t, []int64{6}, ids(b))
	assert.EqualValues(t, 6, b.Cursor)
	// The reader commits after Consume returns.
	assert.Eventually(t, func() bool { return storedCursor(t) == "6" }, 5*time.Second, time.Millisecond)

	// ...unless it does commit after all: the sweep (due on the first wake-up
	// SweepInterval after the previous one) still delivers it.
	time.Sleep(250 * time.Millisecond)
	insertChange(t, 4)
	b = c.next(t)
	assert.Equal(t, []int64{4}, ids(b))
	assert.EqualValues(t, 6, b.Cursor)

	// Processed rows are deleted.
	c.none(t, 300*time.Millisecond)
	assert.Empty(t, outboxIDs(t))
}

func TestReaderRetryAndRestart(t *testing.T) {
	resetOutbox(t)
	require.NoError(t, livesync_model.SetMeta(t.Context(), MetaCursor, "9"))
	setOutboxCounter(t, 9) // ids up to 9 were assigned (and processed)
	c := &fakeConsumer{batches: make(chan *Batch, 16), inTx: true}
	c.fail.Store(2)
	ctx, cancel := context.WithCancel(t.Context())
	r, err := Start(ctx, Config{PollInterval: 20 * time.Millisecond}, c)
	require.NoError(t, err)

	insertChange(t, 10)
	b := c.next(t) // after two failed attempts (backoff 100 ms, 200 ms)
	assert.Equal(t, []int64{10}, ids(b))
	assert.EqualValues(t, 10, b.Cursor)
	assert.Empty(t, outboxIDs(t), "committed by the consumer, in its transaction")
	assert.Equal(t, "10", storedCursor(t))
	cancel()
	require.True(t, r.Wait(5*time.Second))

	// Rows written while no reader runs are read after the restart, from
	// the stored cursor.
	insertChange(t, 11)
	insertChange(t, 13)
	r2 := startReader(t, c)
	_ = r2
	b = c.next(t)
	assert.Equal(t, []int64{11, 13}, ids(b))
	assert.EqualValues(t, 11, b.Cursor, "12 is a hole")
}

func TestReaderOutboxRecreated(t *testing.T) {
	resetOutbox(t)
	require.NoError(t, livesync_model.SetMeta(t.Context(), MetaCursor, "1000"))
	insertChange(t, 1)
	insertChange(t, 2)
	c := &fakeConsumer{batches: make(chan *Batch, 16)}
	startReader(t, c)
	b := c.next(t)
	assert.Equal(t, []int64{1, 2}, ids(b), "ids restarted below the stored cursor: read from the start")
	assert.EqualValues(t, 2, b.Cursor)
}

// The common case of a recreated outbox: it is empty when the reader
// starts, and its counter restarted. New rows must be read at once, not only
// by the sweep (which runs every SweepInterval).
func TestReaderOutboxRecreatedEmpty(t *testing.T) {
	resetOutbox(t)
	require.NoError(t, livesync_model.SetMeta(t.Context(), MetaCursor, "1000"))
	c := &fakeConsumer{batches: make(chan *Batch, 16)}
	ctx, cancel := context.WithCancel(t.Context())
	r, err := Start(ctx, Config{PollInterval: time.Hour, SweepInterval: time.Hour}, c)
	require.NoError(t, err)
	defer func() { cancel(); r.Wait(5 * time.Second) }()
	insertChange(t, 1)
	b := c.next(t)
	assert.Equal(t, []int64{1}, ids(b))
	assert.EqualValues(t, 1, b.Cursor)
	// Its Commit of that batch (cursor 1) could otherwise land after the
	// cursor set below. (Not stopped: cancelling a running query can close
	// the last connection of the in-memory SQLite database.)
	require.Eventually(t, func() bool { return storedCursor(t) == "1" }, 5*time.Second, time.Millisecond)

	// A counter at the cursor (nothing restarted) keeps the cursor.
	resetOutbox(t)
	require.NoError(t, livesync_model.SetMeta(t.Context(), MetaCursor, "50"))
	setOutboxCounter(t, 50)
	r2 := &Reader{}
	require.NoError(t, r2.loadCursor(t.Context()))
	assert.EqualValues(t, 50, r2.cursor)
	setOutboxCounter(t, 49)
	require.NoError(t, r2.loadCursor(t.Context()))
	assert.EqualValues(t, 0, r2.cursor)
}

// The reader runs one cycle per wake-up, never one for its own commit, and
// merges rings that arrive within minCycleGap.
func TestReaderWakeups(t *testing.T) {
	resetOutbox(t)
	c := &fakeConsumer{batches: make(chan *Batch, 16)}
	r := startReader(t, c)
	require.Eventually(t, func() bool { return r.cycles.Load() == 1 }, 5*time.Second, time.Millisecond, "the start-up cycle")

	insertChange(t, 1) // its COMMIT rings once
	assert.Equal(t, []int64{1}, ids(c.next(t)))
	time.Sleep(100 * time.Millisecond)
	assert.EqualValues(t, 2, r.cycles.Load(), "the reader's own commit of the batch must not wake it again")

	// A burst of rings: the first wakes the reader at once, the others are
	// merged into at most one more cycle.
	for range 200 {
		r.bell.ring()
	}
	time.Sleep(100 * time.Millisecond)
	assert.LessOrEqual(t, r.cycles.Load(), int64(4))
	assert.GreaterOrEqual(t, r.cycles.Load(), int64(3))

	// Rings arriving back to back keep the reader at most one cycle per
	// minCycleGap.
	start, before := time.Now(), r.cycles.Load()
	for time.Since(start) < 100*time.Millisecond {
		r.bell.ring()
		time.Sleep(100 * time.Microsecond)
	}
	assert.LessOrEqual(t, r.cycles.Load()-before, int64(100*time.Millisecond/minCycleGap)+2)
}

func TestReaderBatchSize(t *testing.T) {
	resetOutbox(t)
	for id := int64(1); id <= 25; id++ {
		insertChange(t, id)
	}
	c := &fakeConsumer{batches: make(chan *Batch, 16)}
	ctx, cancel := context.WithCancel(t.Context())
	r, err := Start(ctx, Config{PollInterval: time.Hour, BatchSize: 10}, c)
	require.NoError(t, err)
	defer func() { cancel(); r.Wait(5 * time.Second) }()
	var got []int64
	for _, want := range []int{10, 10, 5} {
		b := c.next(t)
		require.Len(t, b.Changes, want)
		got = append(got, ids(b)...)
	}
	assert.Len(t, got, 25)
	assert.EqualValues(t, 1, got[0])
	assert.EqualValues(t, 25, got[24])
}

// WithQuietTx hands fn a real db transaction context: contexts derived from
// it (as Forgejo code derives them: cache.WithCacheContext, timeouts, values)
// stay in the transaction and stay quiet, so a consumer's writes, Batch.Commit
// and the cursor are atomic however the context is wrapped.
func TestWithQuietTx(t *testing.T) {
	resetOutbox(t)
	master, err := livesync_model.MasterXORMEngine()
	require.NoError(t, err)
	observeCommits(master) // as Start does on MySQL (and SQLite)
	d := newDoorbell()
	subscribe(d)
	defer unsubscribe(d)
	rung := func() bool {
		select {
		case <-d.c:
			return true
		default:
			return false
		}
	}
	type key struct{}
	wrap := func(ctx context.Context) context.Context {
		ctx, cancel := context.WithTimeout(cache.WithCacheContext(context.WithValue(ctx, key{}, 1)), time.Minute)
		t.Cleanup(cancel)
		return ctx
	}
	// Any table but livesync's own (whose writes never ring).
	_, err = db.GetEngine(t.Context()).Exec("CREATE TABLE IF NOT EXISTS quiet_tx_test (id INTEGER PRIMARY KEY, name TEXT)")
	require.NoError(t, err)
	_, err = db.GetEngine(t.Context()).Exec("DELETE FROM quiet_tx_test")
	require.NoError(t, err)
	assert.True(t, rung(), "the DELETE rang")
	setName := func(ctx context.Context, name string) {
		t.Helper()
		_, err := db.GetEngine(ctx).Exec("REPLACE INTO quiet_tx_test (id, name) VALUES (1, ?)", name)
		require.NoError(t, err)
	}

	// Commit: every derived context uses the transaction's session, and
	// neither its statements nor its COMMIT ring.
	var hookRan bool
	require.NoError(t, WithQuietTx(t.Context(), func(ctx context.Context) error {
		sess := db.GetEngine(ctx)
		for _, c := range []context.Context{wrap(ctx), cache.WithCacheContext(ctx), context.WithValue(ctx, key{}, 2)} {
			// require: outside the transaction, the writes below would
			// block on its locks.
			require.True(t, db.InTransaction(c))
			require.Same(t, sess, db.GetEngine(c))
			e, err := livesync_model.MasterEngine(c)
			require.NoError(t, err)
			require.Same(t, sess, e)
			assert.NotNil(t, c.Value(quietKey{}))
		}
		setName(wrap(ctx), "quiet")
		db.AfterTx(ctx, func() {
			hookRan = true
			assert.False(t, db.GetEngine(ctx).(*xorm.Session).IsInTx(), "AfterTx hooks run after the commit")
		})
		assert.False(t, hookRan)
		return livesync_model.SetMeta(wrap(ctx), MetaCursor, "7")
	}))
	assert.True(t, hookRan)
	assert.False(t, rung(), "a quiet transaction must not ring")
	assert.Equal(t, "7", storedCursor(t))
	setName(t.Context(), "loud")
	assert.True(t, rung(), "an ordinary write rings")

	// Rollback: writes made through derived contexts are rolled back with
	// the transaction.
	injected := errors.New("injected")
	require.ErrorIs(t, WithQuietTx(t.Context(), func(ctx context.Context) error {
		require.NoError(t, livesync_model.SetMeta(wrap(ctx), MetaCursor, "8"))
		setName(wrap(ctx), "rolled back")
		db.AfterTx(ctx, func() { t.Error("AfterTx hook of a rolled back transaction ran") })
		return injected
	}), injected)
	assert.Equal(t, "7", storedCursor(t))
	var name string
	_, err = db.GetEngine(t.Context()).SQL("SELECT name FROM quiet_tx_test WHERE id = 1").Get(&name)
	require.NoError(t, err)
	assert.Equal(t, "loud", name)

	// Nested in an existing transaction: runs in that one, and so do
	// transactions nested in it.
	hookRan = false
	require.NoError(t, db.WithTx(t.Context(), func(outer context.Context) error {
		require.NoError(t, WithQuietTx(wrap(outer), func(ctx context.Context) error {
			assert.Same(t, db.GetEngine(outer), db.GetEngine(ctx))
			return nil
		}))
		return WithQuietTx(outer, func(ctx context.Context) error {
			assert.Same(t, db.GetEngine(outer), db.GetEngine(ctx))
			db.AfterTx(ctx, func() { hookRan = true })
			return nil
		})
	}))
	assert.True(t, hookRan)
	require.NoError(t, WithQuietTx(t.Context(), func(ctx context.Context) error {
		return db.WithTx(wrap(ctx), func(inner context.Context) error {
			assert.Same(t, db.GetEngine(ctx), db.GetEngine(inner))
			return nil
		})
	}))
}

// deferringConsumer defers the first delivery of every even id.
type deferringConsumer struct {
	batches chan *Batch
	delay   time.Duration
	seen    map[int64]bool
}

func (c *deferringConsumer) Consume(ctx context.Context, b *Batch) error {
	for _, ch := range b.Changes {
		if ch.ID%2 == 0 && !c.seen[ch.ID] {
			b.Defer(ch.ID, time.Now().Add(c.delay))
		}
		c.seen[ch.ID] = true
	}
	if err := WithQuietTx(ctx, b.Commit); err != nil {
		return err
	}
	c.batches <- b
	return nil
}

func TestReaderDefer(t *testing.T) {
	resetOutbox(t)
	fc := &fakeConsumer{batches: make(chan *Batch, 16)}
	c := &deferringConsumer{batches: fc.batches, delay: 300 * time.Millisecond, seen: map[int64]bool{}}
	ctx, cancel := context.WithCancel(t.Context())
	r, err := Start(ctx, Config{PollInterval: 20 * time.Millisecond, HoleTimeout: time.Hour, SweepInterval: time.Hour}, c)
	require.NoError(t, err)
	defer func() { cancel(); r.Wait(5 * time.Second) }()

	// A deferred row at or below the cursor stays in the outbox and comes
	// back once due (the sweep runs for it), not before.
	start := time.Now()
	insertChange(t, 1)
	insertChange(t, 2)
	var got []int64
	for len(got) < 2 {
		got = append(got, ids(fc.next(t))...)
	}
	assert.Equal(t, []int64{1, 2}, got)
	assert.Equal(t, []int64{2}, outboxIDs(t), "deferred: not deleted")
	var kept livesync_model.Change
	_, err = db.GetEngine(t.Context()).ID(2).Get(&kept)
	require.NoError(t, err)
	assert.True(t, kept.Deferred, "deferred: marked")
	insertChange(t, 3)
	assert.Equal(t, []int64{3}, ids(fc.next(t)))
	b := fc.next(t)
	assert.Equal(t, []int64{2}, ids(b))
	assert.GreaterOrEqual(t, time.Since(start), 300*time.Millisecond)
	assert.EqualValues(t, 3, b.Cursor)
	assert.Empty(t, outboxIDs(t))

	// A deferred row above the cursor (a hole below it) is skipped by the
	// hole re-check until due.
	insertChange(t, 6) // 4 and 5 are holes
	assert.Equal(t, []int64{6}, ids(fc.next(t)))
	insertChange(t, 5)
	assert.Equal(t, []int64{5}, ids(fc.next(t)), "the filled hole, without the deferred row")
	b = fc.next(t)
	assert.Equal(t, []int64{6}, ids(b))
	assert.EqualValues(t, 3, b.Cursor, "4 is still open")
	fc.none(t, 100*time.Millisecond)
	assert.Empty(t, outboxIDs(t))
}
