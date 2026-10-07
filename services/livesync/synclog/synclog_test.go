// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package synclog

import (
	"context"
	"sync"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The sync log's logic on SQLite (unit tests only). Locking (FOR UPDATE,
// the lease) and concurrent writers are covered by the TestLivesyncSyncLog*
// integration tests on PostgreSQL and MySQL.

func resetLog(t *testing.T) {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	require.NoError(t, livesync_model.SyncTables(t.Context()))
	for _, q := range []string{"DELETE FROM livesync_log", "DELETE FROM livesync_meta"} {
		_, err := db.GetEngine(t.Context()).Exec(q)
		require.NoError(t, err)
	}
}

func appendEntries(t *testing.T, w *Writer, entries ...Entry) int64 {
	t.Helper()
	var first int64
	require.NoError(t, db.WithTx(t.Context(), func(ctx context.Context) error {
		var err error
		first, err = w.Append(ctx, entries)
		return err
	}))
	return first
}

func entry(group string, id int64) Entry {
	return Entry{Group: group, Model: protocol.ModelLabel, EntityID: id, Op: protocol.OpUpsert, Payload: "{}", SchemaVer: 1, Unit: protocol.UnitIssuesOrPulls}
}

func syncIDs(entries []livesync_model.LogEntry) []int64 {
	res := []int64{}
	for _, e := range entries {
		res = append(res, e.SyncID)
	}
	return res
}

func TestAppendAndReadSince(t *testing.T) {
	resetLog(t)
	ctx := t.Context()
	woken := 0
	w, err := AcquireWriter(ctx, func() { woken++ })
	require.NoError(t, err)
	defer w.Release()

	assert.EqualValues(t, 1, appendEntries(t, w, entry("repo:1", 10), entry("repo:2", 20)))
	assert.EqualValues(t, 3, appendEntries(t, w, entry(protocol.GroupAll, 0), entry("repo:1", 11)))
	assert.EqualValues(t, 5, appendEntries(t, w)) // fencing only: nothing appended
	assert.Equal(t, 2, woken, "the tailer is woken after commits that appended")
	head, err := Head(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 4, head)

	all, err := ReadSince(ctx, "", 0, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 2, 3, 4}, syncIDs(all))
	assert.Equal(t, "repo:2", all[1].Grp)
	assert.Equal(t, string(protocol.UnitIssuesOrPulls), all[1].Unit)
	assert.Positive(t, int64(all[1].CreatedUnix))

	repo1, err := ReadSince(ctx, "repo:1", 0, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 3, 4}, syncIDs(repo1), "a group's entries plus GroupAll's")
	repo1, err = ReadSince(ctx, "repo:1", 1, 1)
	require.NoError(t, err)
	assert.Equal(t, []int64{3}, syncIDs(repo1))
	repo1, err = ReadRange(ctx, "repo:1", 0, 3, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{1, 3}, syncIDs(repo1), "up to until")
	all, err = ReadRange(ctx, "", 1, 3, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{2, 3}, syncIDs(all))

	// A rolled back transaction leaves no gap.
	require.Error(t, db.WithTx(ctx, func(ctx context.Context) error {
		if _, err := w.Append(ctx, []Entry{entry("repo:1", 12)}); err != nil {
			return err
		}
		return assert.AnError
	}))
	assert.EqualValues(t, 5, appendEntries(t, w, entry("repo:1", 13)))

	// Append refuses to run outside a transaction.
	_, err = w.Append(ctx, nil)
	require.Error(t, err)
}

func TestWriterFencing(t *testing.T) {
	resetLog(t)
	ctx := t.Context()
	// On SQLite the lease is not exclusive, which lets this test take over
	// the writer role while the first writer still runs (as after a lost
	// lease connection on PostgreSQL/MySQL).
	old, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)
	appendEntries(t, old, entry("repo:1", 1))
	cur, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)
	assert.Equal(t, old.token+1, cur.token)

	err = db.WithTx(ctx, func(ctx context.Context) error {
		_, err := old.Append(ctx, nil)
		return err
	})
	require.ErrorIs(t, err, ErrNotWriter)
	assert.EqualValues(t, 2, appendEntries(t, cur, entry("repo:1", 2)))

	// A missing head row (meta wiped) continues after the newest entry.
	_, err = db.GetEngine(ctx).Exec("DELETE FROM livesync_meta")
	require.NoError(t, err)
	w, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)
	assert.EqualValues(t, 3, appendEntries(t, w, entry("repo:1", 3)))
}

func TestTrim(t *testing.T) {
	resetLog(t)
	ctx := t.Context()
	w, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)
	for i := range 10 {
		appendEntries(t, w, entry("repo:1", int64(i)))
	}
	// Entries 1-3 are old.
	_, err = db.GetEngine(ctx).Exec("UPDATE livesync_log SET created_unix = ? WHERE sync_id <= 3", time.Now().Add(-48*time.Hour).Unix())
	require.NoError(t, err)

	floor, err := w.Trim(ctx, 24*time.Hour, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 3, floor)
	all, err := ReadSince(ctx, "", 3, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{4, 5, 6, 7, 8, 9, 10}, syncIDs(all))

	_, err = ReadSince(ctx, "repo:1", 2, 100)
	var trimmed *TrimmedError
	require.ErrorAs(t, err, &trimmed)
	assert.EqualValues(t, 3, trimmed.Floor)
	require.ErrorIs(t, err, ErrTrimmed)

	// Keep the newest 4.
	floor, err = w.Trim(ctx, 0, 4)
	require.NoError(t, err)
	assert.EqualValues(t, 6, floor)
	got, err := Floor(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 6, got)
	all, err = ReadSince(ctx, "", 6, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{7, 8, 9, 10}, syncIDs(all))

	// Nothing to do: the floor stays.
	floor, err = w.Trim(ctx, 24*time.Hour, 4)
	require.NoError(t, err)
	assert.EqualValues(t, 6, floor)
}

// Trimming is writer work: a writer that lost its lease cannot trim, and
// the floor never moves down (an old writer's trim interleaving with the new
// writer's would otherwise hide a gap from ReadSince).
func TestTrimFencing(t *testing.T) {
	resetLog(t)
	ctx := t.Context()
	old, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)
	for i := range 10 {
		appendEntries(t, old, entry("repo:1", int64(i)))
	}
	// Another instance takes over (on SQLite the lease is not exclusive).
	cur, err := AcquireWriter(ctx, nil)
	require.NoError(t, err)

	_, err = old.Trim(ctx, 0, 2)
	require.ErrorIs(t, err, ErrNotWriter)
	floor, err := Floor(ctx)
	require.NoError(t, err)
	assert.Zero(t, floor, "nothing trimmed")

	floor, err = cur.Trim(ctx, 0, 2)
	require.NoError(t, err)
	assert.EqualValues(t, 8, floor)

	// A chunk computed from an older floor (a concurrent trim moved it
	// meanwhile) leaves the higher floor alone.
	floor, err = cur.trimTo(ctx, 5)
	require.NoError(t, err)
	assert.EqualValues(t, 8, floor)
	got, err := Floor(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 8, got)
	all, err := ReadSince(ctx, "", 8, 100)
	require.NoError(t, err)
	assert.Equal(t, []int64{9, 10}, syncIDs(all))
}

type recordingSink struct {
	mu      sync.Mutex
	entries []livesync_model.LogEntry
	skipped [][2]int64
}

func (s *recordingSink) Skipped(_ context.Context, from, floor int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.skipped = append(s.skipped, [2]int64{from, floor})
}

func (s *recordingSink) Deliver(_ context.Context, entries []livesync_model.LogEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, entries...)
}

func (s *recordingSink) ids() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return syncIDs(s.entries)
}

func TestTailer(t *testing.T) {
	resetLog(t)
	ctx, cancel := context.WithCancel(t.Context())
	sink := &recordingSink{}
	var tailer *Tailer
	w, err := AcquireWriter(ctx, func() {
		if tailer != nil {
			tailer.Wake()
		}
	})
	require.NoError(t, err)
	appendEntries(t, w, entry("repo:1", 1)) // before the tailer: not delivered

	head, err := Head(ctx)
	require.NoError(t, err)
	tailer, err = StartTailer(ctx, TailerConfig{PollInterval: time.Hour, BatchSize: 2}, head, sink)
	require.NoError(t, err)
	appendEntries(t, w, entry("repo:1", 2), entry("repo:2", 3), entry("repo:1", 4))
	assert.Eventually(t, func() bool { return len(sink.ids()) == 3 }, 5*time.Second, 5*time.Millisecond)
	assert.Equal(t, []int64{2, 3, 4}, sink.ids())

	cancel()
	assert.True(t, tailer.Wait(5*time.Second))

	// A tailer that fell behind the retention floor skips ahead.
	appendEntries(t, w, entry("repo:1", 5), entry("repo:1", 6))
	_, err = w.Trim(t.Context(), 0, 1)
	require.NoError(t, err)
	behind := &recordingSink{}
	stale := &Tailer{cfg: TailerConfig{BatchSize: 10}, sink: behind, pos: 3}
	require.NoError(t, stale.read(t.Context()))
	assert.Equal(t, []int64{6}, behind.ids())
	assert.Equal(t, [][2]int64{{3, 5}}, behind.skipped, "the sink is told")
}
