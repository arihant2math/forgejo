// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/json"
	"forgejo.org/modules/timeutil"
	"forgejo.org/services/livesync/idempotency"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncKeyed builds an API v1 JSON write with an Idempotency-Key.
func livesyncKeyed(t *testing.T, method, path, token, key string, body any) *RequestWrapper {
	t.Helper()
	b, err := json.Marshal(body)
	require.NoError(t, err)
	req := NewRequestWithBody(t, method, path, bytes.NewReader(b)).SetHeader("Content-Type", "application/json").AddTokenAuth(token)
	if key != "" {
		req.SetHeader(protocol.HeaderIdempotencyKey, key)
	}
	return req
}

// livesyncSyncID returns the response's X-Livesync-Sync-Id (required).
func livesyncSyncID(t *testing.T, resp *httptest.ResponseRecorder) int64 {
	t.Helper()
	v := resp.Header().Get(protocol.HeaderSyncID)
	require.NotEmpty(t, v, "X-Livesync-Sync-Id")
	id, err := strconv.ParseInt(v, 10, 64)
	require.NoError(t, err)
	return id
}

// livesyncCovered asserts that the entries of the given entity after cursor
// are already in the log (no waiting: the response promises it) and at or
// below syncID.
func livesyncCovered(t *testing.T, cursor, syncID int64, model protocol.Model, id int64) {
	t.Helper()
	found := 0
	for _, e := range livesyncLogSince(t, cursor) {
		if e.Model == string(model) && e.EntityID == id {
			found++
			assert.LessOrEqual(t, e.SyncID, syncID, "%s %d entry %d is not covered by the sync id", model, id, e.SyncID)
		}
	}
	assert.Positive(t, found, "%s %d has no log entry after %d at the time of the response", model, id, cursor)
}

// livesyncInFlight stores an in-flight idempotency record as an attempt of
// instance would have left it, for the request that req will make.
func livesyncInFlight(t *testing.T, userID int64, req *RequestWrapper, body []byte, instance string, created timeutil.TimeStamp, low int64) {
	t.Helper()
	r := req.Request
	_, err := db.GetEngine(t.Context()).Insert(&livesync_model.Idempotency{
		UserID: userID, Key: r.Header.Get(protocol.HeaderIdempotencyKey), State: livesync_model.IdempotencyInFlight,
		Method: r.Method, Path: r.URL.Path,
		RequestHash: idempotency.RequestHash(r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Content-Type"), "all|all", body),
		Owner:       instance + "/attempt", OutboxLow: low, CreatedUnix: created, UpdatedUnix: created,
	})
	require.NoError(t, err)
}

func livesyncIssueCount(t *testing.T, title string) int64 {
	t.Helper()
	n, err := db.GetEngine(t.Context()).Where("repo_id = ? AND name = ?", 1, title).Count(&issues_model.Issue{})
	require.NoError(t, err)
	return n
}

func TestLivesyncIdempotency(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncServe(t)
	livesyncSettle(t)
	user2 := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 2})
	token := livesyncToken(t, user2)
	const issues = "/api/v1/repos/user2/repo1/issues"

	t.Run("same key twice", func(t *testing.T) {
		cursor := livesyncLogHead(t)
		body := map[string]any{"title": "idem twice", "body": "once **only**"}
		first := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "twice", body), http.StatusCreated)
		syncID := livesyncSyncID(t, first)
		assert.Empty(t, first.Header().Get(protocol.HeaderIdempotentReplay))
		firstBody := first.Body.String()
		var created livesyncIssueRef
		DecodeJSON(t, first, &created)
		livesyncCovered(t, cursor, syncID, protocol.ModelIssue, created.ID)
		livesyncCovered(t, cursor, syncID, protocol.ModelIssueBody, created.ID)

		second := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "twice", body), http.StatusCreated)
		assert.Equal(t, "true", second.Header().Get(protocol.HeaderIdempotentReplay))
		assert.Equal(t, firstBody, second.Body.String())
		assert.Equal(t, first.Header().Get("Content-Type"), second.Header().Get("Content-Type"))
		assert.Equal(t, strconv.FormatInt(syncID, 10), second.Header().Get(protocol.HeaderSyncID))
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem twice"))

		// Another token of the user that may do less (a narrower scope)
		// does not get the stored response.
		narrow := &auth_model.AccessToken{UID: 2, Name: "idem-narrow", Scope: auth_model.AccessTokenScopeWriteIssue, ResourceAllRepos: true}
		require.NoError(t, auth_model.NewAccessToken(t.Context(), narrow))
		MakeRequest(t, livesyncKeyed(t, "POST", issues, narrow.Token, "twice", body), http.StatusUnprocessableEntity)

		// The same key for another request; another user's key of the
		// same name is independent.
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "twice", map[string]any{"title": "idem other"}), http.StatusUnprocessableEntity)
		assert.Zero(t, livesyncIssueCount(t, "idem other"))
		user1 := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 1})
		MakeRequest(t, livesyncKeyed(t, "POST", issues, livesyncToken(t, user1), "twice", body), http.StatusCreated)
		assert.EqualValues(t, 2, livesyncIssueCount(t, "idem twice"))
	})

	t.Run("other writes", func(t *testing.T) {
		// A label added (PUT/POST returning 200) and a comment deleted
		// (204, no body) are stored and replayed like creates.
		cursor := livesyncLogHead(t)
		labels := map[string]any{"labels": []int64{2}}
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues+"/1/labels", token, "label", labels), http.StatusOK)
		syncID := livesyncSyncID(t, resp)
		il := unittest.AssertExistsAndLoadBean(t, &issues_model.IssueLabel{IssueID: 1, LabelID: 2})
		livesyncCovered(t, cursor, syncID, protocol.ModelIssueLabel, il.ID)
		again := MakeRequest(t, livesyncKeyed(t, "POST", issues+"/1/labels", token, "label", labels), http.StatusOK)
		assert.Equal(t, resp.Body.String(), again.Body.String())

		var comment struct{ ID int64 }
		DecodeJSON(t, MakeRequest(t, livesyncKeyed(t, "POST", issues+"/1/comments", token, "comment", map[string]any{"body": "to delete"}), http.StatusCreated), &comment)
		path := fmt.Sprintf("%s/comments/%d", issues, comment.ID)
		cursor = livesyncLogHead(t)
		del := MakeRequest(t, livesyncKeyed(t, "DELETE", path, token, "delete", nil), http.StatusNoContent)
		syncID = livesyncSyncID(t, del)
		e := livesyncWaitLog(t, cursor, time.Second, livesyncEntry(protocol.ModelComment, comment.ID, protocol.OpDelete))
		assert.LessOrEqual(t, e.SyncID, syncID)
		again = MakeRequest(t, livesyncKeyed(t, "DELETE", path, token, "delete", nil), http.StatusNoContent)
		assert.Equal(t, "true", again.Header().Get(protocol.HeaderIdempotentReplay))
		assert.Equal(t, strconv.FormatInt(syncID, 10), again.Header().Get(protocol.HeaderSyncID))
		// Without the key the API answers as usual (the comment is gone).
		MakeRequest(t, NewRequest(t, "DELETE", path).AddTokenAuth(token), http.StatusNotFound)
	})

	t.Run("without the header", func(t *testing.T) {
		before, err := db.GetEngine(t.Context()).Count(&livesync_model.Idempotency{})
		require.NoError(t, err)
		resp := MakeRequest(t, NewRequestWithJSON(t, "POST", issues, map[string]any{"title": "idem plain"}).AddTokenAuth(token), http.StatusCreated)
		assert.NotContains(t, resp.Header(), protocol.HeaderSyncID)
		assert.NotContains(t, resp.Header(), protocol.HeaderIdempotentReplay)
		// GET with a key: a safe method, untouched too.
		resp = MakeRequest(t, NewRequest(t, "GET", issues+"/1").AddTokenAuth(token).SetHeader(protocol.HeaderIdempotencyKey, "get"), http.StatusOK)
		assert.NotContains(t, resp.Header(), protocol.HeaderSyncID)
		after, err := db.GetEngine(t.Context()).Count(&livesync_model.Idempotency{})
		require.NoError(t, err)
		assert.Equal(t, before, after)
	})

	t.Run("auth", func(t *testing.T) {
		body := map[string]any{"title": "idem auth"}
		MakeRequest(t, livesyncKeyed(t, "POST", issues, "", "auth", body), http.StatusUnauthorized)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, "not-a-token", "auth", body), http.StatusUnauthorized)
		// Basic auth: API v1 would accept a password, the layer only
		// tokens (an OAuth2 token as the basic password works): refused
		// rather than run without the key being honoured.
		MakeRequest(t, livesyncKeyed(t, "POST", issues, "", "auth", body).AddBasicAuth("user2"), http.StatusUnauthorized)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, "", "auth", body).SetHeader("Authorization", `Signature keyId="x"`), http.StatusBadRequest)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "bad\tkey", body), http.StatusBadRequest)
		req := livesyncKeyed(t, "POST", issues, token, "a", body)
		req.Header.Add(protocol.HeaderIdempotencyKey, "b")
		MakeRequest(t, req, http.StatusBadRequest)
		assert.Zero(t, livesyncIssueCount(t, "idem auth"))
	})

	t.Run("concurrent duplicates", func(t *testing.T) {
		body := map[string]any{"title": "idem concurrent", "body": "race"}
		const n = 8
		var wg sync.WaitGroup
		results := make([]*httptest.ResponseRecorder, n)
		for i := range n {
			wg.Go(func() {
				results[i] = MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "concurrent", body), NoExpectedStatus)
			})
		}
		wg.Wait()
		ran, replayed, conflicts := 0, 0, 0
		var original string
		for _, r := range results {
			switch {
			case r.Code == http.StatusCreated && r.Header().Get(protocol.HeaderIdempotentReplay) == "":
				ran++
				original = r.Body.String()
			case r.Code == http.StatusCreated:
				replayed++
			case r.Code == http.StatusConflict:
				conflicts++
				assert.Equal(t, "1", r.Header().Get("Retry-After"))
			default:
				t.Errorf("unexpected response %d %s", r.Code, r.Body.String())
			}
		}
		assert.Equal(t, 1, ran)
		assert.Equal(t, n-1, replayed+conflicts)
		for _, r := range results {
			if r.Code == http.StatusCreated {
				assert.Equal(t, original, r.Body.String())
			}
		}
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem concurrent"))
		t.Logf("concurrent duplicates: %d replayed, %d conflicts", replayed, conflicts)
	})

	t.Run("in flight on a live instance", func(t *testing.T) {
		// An attempt of another instance that is alive (it holds its lock)
		// is in progress: 409 until the instance is gone; then the retry
		// recovers the key and, nothing having been created, runs.
		const instance = "00000000000000aa"
		lease, err := livesync_model.TryLease(t.Context(), "livesync.idem."+instance)
		require.NoError(t, err)
		defer lease.Release()
		bodyMap := map[string]any{"title": "idem in flight", "body": "x"}
		raw, _ := json.Marshal(bodyMap)
		req := livesyncKeyed(t, "POST", issues, token, "inflight", bodyMap)
		low, err := idempotency.Position(t.Context())
		require.NoError(t, err)
		livesyncInFlight(t, 2, req, raw, instance, timeutil.TimeStampNow(), low)

		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "inflight", bodyMap), http.StatusConflict)
		assert.Equal(t, "1", resp.Header().Get("Retry-After"))
		lease.Release()
		cursor := livesyncLogHead(t)
		resp = MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "inflight", bodyMap), http.StatusCreated)
		var created livesyncIssueRef
		DecodeJSON(t, resp, &created)
		livesyncCovered(t, cursor, livesyncSyncID(t, resp), protocol.ModelIssue, created.ID)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem in flight"))
	})

	// A forced crash: the write committed, the process died before the
	// response was stored (the record is left in flight, owned by an
	// instance whose lock is free). The retry answers with what was
	// created instead of creating it again.
	crash := func(t *testing.T, key, path string, body map[string]any, write func() (status int, read string)) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := livesyncKeyed(t, "POST", path, token, key, body)
		low, err := idempotency.Position(t.Context())
		require.NoError(t, err)
		livesyncInFlight(t, 2, req, raw, "00000000000000dd", timeutil.TimeStampNow()-1, low)
		wantStatus, readPath := write()
		read := MakeRequest(t, NewRequest(t, "GET", readPath).AddTokenAuth(token), http.StatusOK)
		cursor := livesyncLogHead(t)

		resp := MakeRequest(t, livesyncKeyed(t, "POST", path, token, key, body), wantStatus)
		assert.Empty(t, resp.Header().Get(protocol.HeaderIdempotentReplay))
		assert.JSONEq(t, read.Body.String(), resp.Body.String())
		syncID := livesyncSyncID(t, resp)
		assert.GreaterOrEqual(t, syncID, cursor)
		// Stored now: the next retry is a plain replay.
		again := MakeRequest(t, livesyncKeyed(t, "POST", path, token, key, body), wantStatus)
		assert.Equal(t, "true", again.Header().Get(protocol.HeaderIdempotentReplay))
		assert.Equal(t, resp.Body.String(), again.Body.String())
		return resp
	}

	t.Run("crash after an issue was created", func(t *testing.T) {
		body := map[string]any{"title": "idem crash issue", "body": "created before the crash"}
		var created livesyncIssueRef
		cursor := livesyncLogHead(t)
		resp := crash(t, "crash-issue", issues, body, func() (int, string) {
			DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", issues, body).AddTokenAuth(token), http.StatusCreated), &created)
			return http.StatusCreated, fmt.Sprintf("%s/%d", issues, created.Number)
		})
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem crash issue"))
		// The interrupted attempt's changes are covered too (its outbox
		// position is the record's).
		livesyncCovered(t, cursor, livesyncSyncID(t, resp), protocol.ModelIssue, created.ID)
	})

	t.Run("crash after a comment was created", func(t *testing.T) {
		path := issues + "/1/comments"
		body := map[string]any{"body": "idem crash comment"}
		crash(t, "crash-comment", path, body, func() (int, string) {
			var c struct{ ID int64 }
			DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", path, body).AddTokenAuth(token), http.StatusCreated), &c)
			return http.StatusCreated, fmt.Sprintf("%s/comments/%d", issues, c.ID)
		})
		n, err := db.GetEngine(t.Context()).Where("issue_id = 1 AND content = ?", "idem crash comment").Count(&issues_model.Comment{})
		require.NoError(t, err)
		assert.EqualValues(t, 1, n)
	})

	t.Run("crash after a review was created", func(t *testing.T) {
		path := "/api/v1/repos/user2/repo1/pulls/2/reviews"
		body := map[string]any{"event": "COMMENT", "body": "idem crash review"}
		crash(t, "crash-review", path, body, func() (int, string) {
			var r struct{ ID int64 }
			DecodeJSON(t, MakeRequest(t, NewRequestWithJSON(t, "POST", path, body).AddTokenAuth(token), http.StatusOK), &r)
			return http.StatusOK, fmt.Sprintf("%s/%d", path, r.ID)
		})
		n, err := db.GetEngine(t.Context()).Where("issue_id = 2 AND content = ?", "idem crash review").Count(&issues_model.Review{})
		require.NoError(t, err)
		assert.EqualValues(t, 1, n)
	})

	t.Run("crash before the commit", func(t *testing.T) {
		// Nothing was created: the retry runs the request.
		body := map[string]any{"title": "idem crash early"}
		raw, _ := json.Marshal(body)
		req := livesyncKeyed(t, "POST", issues, token, "crash-early", body)
		low, err := idempotency.Position(t.Context())
		require.NoError(t, err)
		livesyncInFlight(t, 2, req, raw, "00000000000000ee", timeutil.TimeStampNow()-1, low)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "crash-early", body), http.StatusCreated)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem crash early"))
	})

	t.Run("sync id when the materializer is late", func(t *testing.T) {
		// A record completed without a sync id (the wait timed out) gets
		// one at its replay.
		ctx := context.Background()
		body := map[string]any{"title": "idem late"}
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "late", body), http.StatusCreated)
		syncID := livesyncSyncID(t, resp)
		_, err := db.GetEngine(ctx).Exec("UPDATE livesync_idempotency SET sync_id = -1 WHERE user_id = 2 AND idem_key = 'late'")
		require.NoError(t, err)
		again := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "late", body), http.StatusCreated)
		assert.GreaterOrEqual(t, livesyncSyncID(t, again), syncID)
		var rec livesync_model.Idempotency
		_, err = db.GetEngine(ctx).Where("user_id = 2 AND idem_key = 'late'").Get(&rec)
		require.NoError(t, err)
		assert.Equal(t, livesyncSyncID(t, again), rec.SyncID)
	})
}

// livesyncIssueRef is the part of an API v1 issue the tests read.
type livesyncIssueRef struct {
	ID     int64 `json:"id"`
	Number int64 `json:"number"`
}

// TestLivesyncIdempotencyDelta checks the sync id echo against what a sync
// session receives: the deltas of a keyed write have v at or below the
// response's X-Livesync-Sync-Id. It also logs what the wait costs.
func TestLivesyncIdempotencyDelta(t *testing.T) {
	livesyncSkipSQLite(t)
	livesyncServe(t)
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		livesyncSettle(t)
		token := livesyncToken(t, &user_model.User{ID: 2})
		cl := livesyncDial(t, u, "ws")
		cl.send(livesyncHello(token, protocol.GroupRequest{Group: "repo:1"}))
		cl.waitType(protocol.MsgWelcome)

		resp := MakeRequest(t, livesyncKeyed(t, "POST", "/api/v1/repos/user2/repo1/issues", token, "delta", map[string]any{"title": "idem delta"}), http.StatusCreated)
		syncID := livesyncSyncID(t, resp)
		var created livesyncIssueRef
		DecodeJSON(t, resp, &created)
		ch := cl.waitChange("the issue", func(ch *protocol.Change) bool { return ch.M == protocol.ModelIssue && ch.ID == created.ID })
		assert.LessOrEqual(t, ch.V, syncID)

		// Latency of keyed writes (reserve, run, wait for the
		// materializer, store) against plain ones.
		const n = 10
		measure := func(key func(i int) string) time.Duration {
			start := time.Now()
			for i := range n {
				MakeRequest(t, livesyncKeyed(t, "POST", "/api/v1/repos/user2/repo1/labels", token, key(i), map[string]any{"name": fmt.Sprintf("idem-%s-%d", key(0), i), "color": "#00aabb"}), http.StatusCreated)
			}
			return time.Since(start) / n
		}
		plain := measure(func(int) string { return "" })
		keyed := measure(func(i int) string { return fmt.Sprintf("bench-%d", i) })
		t.Logf("label create: %s plain, %s with Idempotency-Key (incl. the wait for the materializer)", plain, keyed)
	})
}
