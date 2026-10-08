// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package idempotency

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	"forgejo.org/modules/timeutil"
	"forgejo.org/services/livesync/synclog"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMain(m *testing.M) {
	unittest.MainTest(m)
}

// The store's logic on SQLite (unit tests only; there TryLease always
// succeeds, so every other instance looks dead). Locks between instances,
// concurrency and the HTTP layer are covered by TestLivesyncIdempotency* on
// PostgreSQL and MySQL.

func prepare(t *testing.T, cfg Config) *Service {
	t.Helper()
	require.NoError(t, unittest.PrepareTestDatabase())
	require.NoError(t, livesync_model.SyncTables(t.Context()))
	for _, q := range []string{"DELETE FROM livesync_idempotency", "DELETE FROM livesync_change", "DELETE FROM livesync_meta"} {
		_, err := db.GetEngine(t.Context()).Exec(q)
		require.NoError(t, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Start(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(func() {
		cancel()
		s.Stop(time.Second)
	})
	return s
}

func record(t *testing.T, userID int64, key string) *livesync_model.Idempotency {
	t.Helper()
	rec, has, err := getRecord(t.Context(), userID, key)
	require.NoError(t, err)
	require.True(t, has)
	return rec
}

func TestValidKey(t *testing.T) {
	assert.True(t, ValidKey("0b6b1c7e-6f1d-4b8e-9a52-6f7f0e3c2a11"))
	assert.True(t, ValidKey("a"))
	assert.True(t, ValidKey("x y"))
	long := make([]byte, MaxKeyLength)
	for i := range long {
		long[i] = 'k'
	}
	assert.True(t, ValidKey(string(long)))
	assert.False(t, ValidKey(string(long)+"k"))
	assert.False(t, ValidKey(""))
	assert.False(t, ValidKey("tab\there"))
	assert.False(t, ValidKey("ünïcode"))
}

func TestRequestHash(t *testing.T) {
	base := RequestHash("POST", "/api/v1/repos/a/b/issues", "", "application/json", "all", []byte(`{"title":"x"}`))
	assert.Len(t, base, 64)
	assert.Equal(t, base, RequestHash("POST", "/api/v1/repos/a/b/issues", "", "application/json", "all", []byte(`{"title":"x"}`)))
	for _, other := range []string{
		RequestHash("PUT", "/api/v1/repos/a/b/issues", "", "application/json", "all", []byte(`{"title":"x"}`)),
		RequestHash("POST", "/api/v1/repos/a/c/issues", "", "application/json", "all", []byte(`{"title":"x"}`)),
		RequestHash("POST", "/api/v1/repos/a/b/issues", "x=1", "application/json", "all", []byte(`{"title":"x"}`)),
		RequestHash("POST", "/api/v1/repos/a/b/issues", "", "text/plain", "all", []byte(`{"title":"x"}`)),
		RequestHash("POST", "/api/v1/repos/a/b/issues", "", "application/json", "all", []byte(`{"title":"y"}`)),
		RequestHash("POST", "/api/v1/repos/a/b/issues", "", "application/json", "write:issue|all", []byte(`{"title":"x"}`)),
		// Parts cannot be shifted into each other.
		RequestHash("POST", "/api/v1/repos/a/b/issues", "", "application/json{", "all", []byte(`"title":"x"}`)),
	} {
		assert.NotEqual(t, base, other)
	}
}

func TestBeginCompleteReplay(t *testing.T) {
	s := prepare(t, Config{})
	ctx := t.Context()
	req := Request{UserID: 2, Key: "k1", Method: "POST", Path: "/api/v1/repos/user2/repo1/issues", Hash: "h1"}

	b, err := s.Begin(ctx, req)
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	res := b.Reservation
	assert.False(t, res.Recovered)
	rec := record(t, 2, "k1")
	assert.Equal(t, livesync_model.IdempotencyInFlight, rec.State)
	assert.Equal(t, res.owner, rec.Owner)

	// A retry while it runs (in this process): in flight. Another user's
	// key of the same name is independent.
	b2, err := s.Begin(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, InFlight, b2.Outcome)
	other := req
	other.UserID = 3
	b3, err := s.Begin(ctx, other)
	require.NoError(t, err)
	assert.Equal(t, Run, b3.Outcome)

	ok, err := s.Complete(ctx, res, Response{Status: 201, Headers: `{"Content-Type":["application/json"]}`, Body: []byte(`{"id":1}`), SyncID: 42, High: 7})
	require.NoError(t, err)
	assert.True(t, ok)
	_, running := s.running.Load(res.owner)
	assert.False(t, running)

	b, err = s.Begin(ctx, req)
	require.NoError(t, err)
	require.Equal(t, Replay, b.Outcome)
	assert.Equal(t, 201, b.Record.Status)
	assert.JSONEq(t, `{"id":1}`, string(b.Record.Body))
	assert.Equal(t, int64(42), b.Record.SyncID)
	assert.Equal(t, int64(7), b.Record.OutboxHigh)
	assert.Empty(t, b.Record.Owner)

	// The same key for another request.
	mismatch := req
	mismatch.Hash = "h2"
	b, err = s.Begin(ctx, mismatch)
	require.NoError(t, err)
	assert.Equal(t, Mismatch, b.Outcome)

	// Completing twice (or after a takeover) stores nothing.
	ok, err = s.Complete(ctx, res, Response{Status: 500})
	require.NoError(t, err)
	assert.False(t, ok)
	assert.Equal(t, 201, record(t, 2, "k1").Status)
}

func TestReleaseRecovers(t *testing.T) {
	s := prepare(t, Config{})
	ctx := t.Context()
	_, err := db.GetEngine(ctx).Insert(&livesync_model.Change{Tbl: "issue", RowID: 1, Op: livesync_model.OpInsert})
	require.NoError(t, err)
	req := Request{UserID: 2, Key: "k", Method: "POST", Path: "/p", Hash: "h"}
	b, err := s.Begin(ctx, req)
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	first := b.Reservation
	assert.Positive(t, first.Low)

	// A server error: released, the next attempt recovers it with the
	// first attempt's outbox position and time.
	require.NoError(t, s.Release(ctx, first))
	assert.Empty(t, record(t, 2, "k").Owner)
	_, err = db.GetEngine(ctx).Insert(&livesync_model.Change{Tbl: "issue", RowID: 2, Op: livesync_model.OpInsert})
	require.NoError(t, err)
	b, err = s.Begin(ctx, req)
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	assert.True(t, b.Reservation.Recovered)
	assert.Equal(t, first.Low, b.Reservation.Low)
	assert.Equal(t, first.Since, b.Reservation.Since)

	// The released attempt cannot complete any more.
	ok, err := s.Complete(ctx, first, Response{Status: 201})
	require.NoError(t, err)
	assert.False(t, ok)
	ok, err = s.Complete(ctx, b.Reservation, Response{Status: 201})
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestTakeOverInterrupted(t *testing.T) {
	s := prepare(t, Config{})
	ctx := t.Context()
	now := timeutil.TimeStampNow()
	insert := func(key, owner string, created timeutil.TimeStamp) {
		_, err := db.GetEngine(ctx).Insert(&livesync_model.Idempotency{
			UserID: 2, Key: key, State: livesync_model.IdempotencyInFlight, Method: "POST", Path: "/p", RequestHash: "h",
			Owner: owner, OutboxLow: 5, CreatedUnix: created, UpdatedUnix: created,
		})
		require.NoError(t, err)
	}
	// Another instance that is gone (its lock is free).
	insert("crashed", "0123456789abcdef/t", now-10)
	b, err := s.Begin(ctx, Request{UserID: 2, Key: "crashed", Method: "POST", Path: "/p", Hash: "h"})
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	assert.True(t, b.Reservation.Recovered)
	assert.Equal(t, int64(5), b.Reservation.Low)
	assert.Equal(t, now-10, b.Reservation.Since)
	assert.Equal(t, b.Reservation.owner, record(t, 2, "crashed").Owner)

	// This process, an attempt no longer running (e.g. its release failed).
	insert("stale", s.id+"/gone", now)
	b, err = s.Begin(ctx, Request{UserID: 2, Key: "stale", Method: "POST", Path: "/p", Hash: "h"})
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	assert.True(t, b.Reservation.Recovered)

	// Expired records are as if they did not exist.
	insert("old", "0123456789abcdef/t", timeutil.TimeStamp(time.Now().Add(-8*24*time.Hour).Unix()))
	b, err = s.Begin(ctx, Request{UserID: 2, Key: "old", Method: "POST", Path: "/p", Hash: "other"})
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	assert.False(t, b.Reservation.Recovered)
}

func TestCleanup(t *testing.T) {
	s := prepare(t, Config{TTL: time.Hour})
	ctx := t.Context()
	for i, age := range []time.Duration{0, 30 * time.Minute, 2 * time.Hour, 9 * 24 * time.Hour} {
		ts := timeutil.TimeStamp(time.Now().Add(-age).Unix())
		_, err := db.GetEngine(ctx).Insert(&livesync_model.Idempotency{UserID: 1, Key: strconv.Itoa(i), Method: "POST", Path: "/p", RequestHash: "h", CreatedUnix: ts, UpdatedUnix: ts})
		require.NoError(t, err)
	}
	n, err := Cleanup(ctx, s.cfg.TTL)
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	count, err := db.GetEngine(ctx).Count(&livesync_model.Idempotency{})
	require.NoError(t, err)
	assert.EqualValues(t, 2, count)
}

func TestWaitSynced(t *testing.T) {
	s := prepare(t, Config{SyncWait: 300 * time.Millisecond})
	ctx := t.Context()
	require.NoError(t, livesync_model.SetMeta(ctx, synclog.MetaHead, "17"))
	low, err := Position(ctx)
	require.NoError(t, err)
	var ids []int64
	for i := range 3 {
		c := &livesync_model.Change{Tbl: "label", RowID: int64(i + 1), Op: livesync_model.OpUpdate}
		_, err := db.GetEngine(ctx).Insert(c)
		require.NoError(t, err)
		ids = append(ids, c.ID)
	}
	high, err := Position(ctx)
	require.NoError(t, err)
	assert.Equal(t, ids[2], high)

	// Nothing in the range (or an empty range): the head at once.
	head, ok := s.WaitSynced(ctx, high, high)
	assert.True(t, ok)
	assert.Equal(t, int64(17), head)
	head, ok = s.WaitSynced(ctx, ids[0], ids[0]) // rows outside (low, high] do not count
	assert.True(t, ok)
	assert.Equal(t, int64(17), head)

	// Rows pending: times out.
	start := time.Now()
	_, ok = s.WaitSynced(ctx, low, high)
	assert.False(t, ok)
	assert.GreaterOrEqual(t, time.Since(start), 300*time.Millisecond)

	// The "materializer" consumes them and rings: the waiter returns the
	// head it wrote, long before the bound.
	s.cfg.SyncWait = 10 * time.Second
	done := make(chan int64)
	go func() {
		head, ok := s.WaitSynced(ctx, low, high)
		assert.True(t, ok)
		done <- head
	}()
	time.Sleep(50 * time.Millisecond)
	require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
		if _, err := db.GetEngine(ctx).In("id", ids).Delete(&livesync_model.Change{}); err != nil {
			return err
		}
		return livesync_model.SetMeta(ctx, synclog.MetaHead, "20")
	}))
	start = time.Now()
	s.Notify()
	select {
	case head := <-done:
		assert.Equal(t, int64(20), head)
		assert.Less(t, time.Since(start), time.Second)
	case <-time.After(5 * time.Second):
		t.Fatal("WaitSynced did not return")
	}

	// A cancelled request stops waiting.
	_, err = db.GetEngine(ctx).Insert(&livesync_model.Change{Tbl: "label", RowID: 9, Op: livesync_model.OpUpdate})
	require.NoError(t, err)
	high2, err := Position(ctx)
	require.NoError(t, err)
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	_, ok = s.WaitSynced(cctx, high, high2)
	assert.False(t, ok)
}

func TestSignal(t *testing.T) {
	var s Signal
	c1 := s.C()
	assert.Equal(t, c1, s.C())
	s.Broadcast()
	select {
	case <-c1:
	default:
		t.Fatal("not closed")
	}
	c2 := s.C()
	assert.NotEqual(t, c1, c2)
	s.Broadcast()
	s.Broadcast() // nobody waiting: fine
	<-c2
}

func TestFindDuplicate(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()
	const jsonType = "application/json; charset=utf-8"
	find := func(userID int64, method, path, contentType, body string, since timeutil.TimeStamp) *Duplicate {
		t.Helper()
		dup, err := FindDuplicate(ctx, userID, method, path, contentType, []byte(body), since)
		if errors.Is(err, ErrNoDuplicate) {
			return nil
		}
		require.NoError(t, err)
		require.NotNil(t, dup)
		return dup
	}
	// Fixtures: issue 1 (repo 1 = user2/repo1, poster 1, created 946684800),
	// comment 2 on it (poster 3, "good work!", 946684811), pull request
	// issue 2 with review 1 (reviewer 1, type approve, "Demo Review") and
	// pending review 4 ("Pending Review").
	const created = timeutil.TimeStamp(946684800)

	assert.Equal(t, &Duplicate{Status: http.StatusCreated, Path: "/repos/user2/repo1/issues/1"},
		find(1, "POST", "/repos/user2/repo1/issues", jsonType, `{"title":"  issue1 ","body":"content for the first issue","labels":[1]}`, created))
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/issues", jsonType, `{"title":"issue1","body":"content for the first issue"}`, created+60), "created before the first attempt")
	assert.Nil(t, find(2, "POST", "/repos/user2/repo1/issues", jsonType, `{"title":"issue1","body":"content for the first issue"}`, created), "another poster")
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/issues", jsonType, `{"title":"issue1","body":"Content for the first issue"}`, created), "content differs (case)")
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/issues", jsonType, `{"title":"issue2","body":"content for the second issue"}`, created), "a pull request")
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/issues", "application/x-www-form-urlencoded", `title=issue1`, created), "not JSON")
	assert.Nil(t, find(1, "PATCH", "/repos/user2/repo1/issues", jsonType, `{"title":"issue1","body":"content for the first issue"}`, created), "not a create")
	assert.Nil(t, find(1, "POST", "/repos/user2/nope/issues", jsonType, `{"title":"issue1","body":"content for the first issue"}`, created), "no such repository")
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/issues", jsonType, `not json`, created))

	assert.Equal(t, &Duplicate{Status: http.StatusCreated, Path: "/repos/user2/repo1/issues/comments/2"},
		find(3, "POST", "/repos/user2/repo1/issues/1/comments", jsonType, `{"body":"good work!"}`, created))
	assert.Nil(t, find(3, "POST", "/repos/user2/repo1/issues/1/comments", jsonType, `{"body":"Good work!"}`, created))
	assert.Nil(t, find(3, "POST", "/repos/user2/repo1/issues/99/comments", jsonType, `{"body":"good work!"}`, created))
	assert.Nil(t, find(3, "POST", "/repos/user2/repo1/issues/x/comments", jsonType, `{"body":"good work!"}`, created))

	assert.Equal(t, &Duplicate{Status: http.StatusOK, Path: "/repos/user2/repo1/pulls/2/reviews/1"},
		find(1, "POST", "/repos/user2/repo1/pulls/2/reviews", jsonType, `{"event":"APPROVED","body":"Demo Review"}`, created))
	assert.Equal(t, &Duplicate{Status: http.StatusOK, Path: "/repos/user2/repo1/pulls/2/reviews/4"},
		find(1, "POST", "/repos/user2/repo1/pulls/2/reviews", jsonType, `{"body":"Pending Review"}`, created))
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/pulls/2/reviews", jsonType, `{"event":"COMMENT","body":"Demo Review"}`, created), "another type")
	assert.Nil(t, find(1, "POST", "/repos/user2/repo1/pulls/1/reviews", jsonType, `{"event":"APPROVED","body":"Demo Review"}`, created), "not a pull request")
}

// A stopping instance keeps its lock while its attempts run.
func TestStopDrains(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	require.NoError(t, livesync_model.SyncTables(t.Context()))
	ctx, cancel := context.WithCancel(context.Background())
	s, err := Start(ctx, Config{})
	require.NoError(t, err)
	b, err := s.Begin(t.Context(), Request{UserID: 9, Key: "drain", Method: "POST", Path: "/p", Hash: "h"})
	require.NoError(t, err)
	require.Equal(t, Run, b.Outcome)
	cancel()
	assert.False(t, s.Stop(100*time.Millisecond), "the lock is kept while the attempt runs")
	ok, err := s.Complete(t.Context(), b.Reservation, Response{Status: 204, SyncID: -1})
	require.NoError(t, err)
	assert.True(t, ok)
	assert.True(t, s.Stop(time.Second))
}
