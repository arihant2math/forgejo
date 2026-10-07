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
	assert.Equal(t, "6", storedCursor(t))

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
