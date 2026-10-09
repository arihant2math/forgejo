// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
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
	"forgejo.org/modules/setting"
	"forgejo.org/modules/timeutil"
	"forgejo.org/routers"
	livesync_service "forgejo.org/services/livesync"
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
		RequestHash: idempotency.RequestHash(r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Content-Type"), r.Header.Get("Sudo"), "all|all", body),
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

	t.Run("credential-issuing routes", func(t *testing.T) {
		// Their response carries a secret upstream keeps only hashed: not
		// stored, so not keyed (400), and nothing created.
		before, err := db.GetEngine(t.Context()).Count(&livesync_model.Idempotency{})
		require.NoError(t, err)
		MakeRequest(t, livesyncKeyed(t, "POST", "/api/v1/user/applications/oauth2", token, "oauth2", map[string]any{"name": "idem-app", "redirect_uris": []string{"https://example.com/cb"}}), http.StatusBadRequest)
		n, err := db.GetEngine(t.Context()).Where("name = ?", "idem-app").Count(&auth_model.OAuth2Application{})
		require.NoError(t, err)
		assert.Zero(t, n)
		MakeRequest(t, livesyncKeyed(t, "POST", "/api/v1/repos/user2/repo1/actions/runners", token, "runner", map[string]any{"token": "x"}), http.StatusBadRequest)
		after, err := db.GetEngine(t.Context()).Count(&livesync_model.Idempotency{})
		require.NoError(t, err)
		assert.Equal(t, before, after)
	})

	t.Run("token in the query or form", func(t *testing.T) {
		// API v1 prefers a query/form token to the header: the layer
		// would key on another user, and hash the token.
		body := map[string]any{"title": "idem query token"}
		MakeRequest(t, livesyncKeyed(t, "POST", issues+"?token="+token, "", "qtoken", body), http.StatusBadRequest)
		MakeRequest(t, livesyncKeyed(t, "POST", issues+"?access_token="+token, token, "qtoken", body), http.StatusBadRequest)
		form := NewRequestWithBody(t, "POST", issues, strings.NewReader("title=idem+query+token&token="+token)).
			SetHeader("Content-Type", "application/x-www-form-urlencoded").AddTokenAuth(token).SetHeader(protocol.HeaderIdempotencyKey, "ftoken")
		MakeRequest(t, form, http.StatusBadRequest)
		assert.Zero(t, livesyncIssueCount(t, "idem query token"))
	})

	t.Run("authenticated before the body is read", func(t *testing.T) {
		body := &livesyncReadCounter{r: strings.NewReader(`{"title":"idem unread"}`)}
		req := NewRequestWithBody(t, "POST", issues, body).SetHeader("Content-Type", "application/json").SetHeader(protocol.HeaderIdempotencyKey, "unread")
		MakeRequest(t, req, http.StatusUnauthorized)
		assert.Zero(t, body.n)
	})

	t.Run("sudo", func(t *testing.T) {
		admin := livesyncToken(t, unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 1}))
		body := map[string]any{"title": "idem sudo", "body": "as someone else"}
		var created struct {
			ID     int64 `json:"id"`
			Poster struct {
				ID int64 `json:"id"`
			} `json:"user"`
		}
		DecodeJSON(t, MakeRequest(t, livesyncKeyed(t, "POST", issues, admin, "sudo", body).SetHeader("Sudo", "user2"), http.StatusCreated), &created)
		assert.EqualValues(t, 2, created.Poster.ID)
		// Another user to act as: another request, not a replay of user2's.
		MakeRequest(t, livesyncKeyed(t, "POST", issues, admin, "sudo", body).SetHeader("Sudo", "user4"), http.StatusUnprocessableEntity)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem sudo"))

		// The crash-window check looks for what the user acted as created.
		crashBody := map[string]any{"title": "idem sudo crash", "body": "x"}
		raw, _ := json.Marshal(crashBody)
		req := livesyncKeyed(t, "POST", issues, admin, "sudo-crash", crashBody).SetHeader("Sudo", "user2")
		low, err := idempotency.Position(t.Context())
		require.NoError(t, err)
		livesyncInFlight(t, 1, req, raw, "00000000000000ab", timeutil.TimeStampNow()-1, low)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, admin, "", crashBody).SetHeader("Sudo", "user2"), http.StatusCreated)
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, admin, "sudo-crash", crashBody).SetHeader("Sudo", "user2"), http.StatusCreated)
		assert.Empty(t, resp.Header().Get(protocol.HeaderIdempotentReplay))
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem sudo crash"))
	})

	t.Run("long non-ASCII path", func(t *testing.T) {
		// The stored path is cut at a character boundary (and made valid
		// UTF-8): the request runs (here: 404) instead of failing with 500.
		for i, p := range []string{
			issues + "/" + url.PathEscape(strings.Repeat("é", 600)) + "/comments",
			issues + "/%FF/comments",
		} {
			resp := MakeRequest(t, livesyncKeyed(t, "POST", p, token, fmt.Sprintf("long-%d", i), map[string]any{"body": "x"}), NoExpectedStatus)
			assert.Less(t, resp.Code, http.StatusInternalServerError, resp.Body.String())
			var rec livesync_model.Idempotency
			has, err := db.GetEngine(t.Context()).Where("user_id = 2 AND idem_key = ?", fmt.Sprintf("long-%d", i)).Get(&rec)
			require.NoError(t, err)
			require.True(t, has)
			assert.Equal(t, livesync_model.IdempotencyCompleted, rec.State)
		}
	})

	t.Run("account checks", func(t *testing.T) {
		// A replay is refused like API v1 refuses the account.
		user4 := unittest.AssertExistsAndLoadBean(t, &user_model.User{ID: 4})
		token4 := livesyncToken(t, user4)
		body := map[string]any{"title": "idem prohibited"}
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token4, "account", body), http.StatusCreated)
		_, err := db.GetEngine(t.Context()).Exec("UPDATE `user` SET prohibit_login = ? WHERE id = 4", true)
		require.NoError(t, err)
		defer func() {
			_, err := db.GetEngine(context.Background()).Exec("UPDATE `user` SET prohibit_login = ? WHERE id = 4", false)
			require.NoError(t, err)
		}()
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token4, "account", body), http.StatusForbidden)
		assert.Contains(t, resp.Body.String(), "prohibited from signing in")
		assert.Empty(t, resp.Header().Get(protocol.HeaderIdempotentReplay))
	})
}

// livesyncReadCounter counts the bytes read from a request body.
type livesyncReadCounter struct {
	r io.Reader
	n int
}

func (c *livesyncReadCounter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
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

// TestLivesyncIdempotencyServerErrors runs the layer in front of an inner
// handler that fails on purpose (X-Test-Fail): a 5xx or a panic releases the
// record, and the next retry is recovered (crash-window check, then run).
// It also checks that rows the materializer deferred do not hold the sync
// wait up.
func TestLivesyncIdempotencyServerErrors(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	real := routers.NormalRoutes()
	inner := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.Header.Get("X-Test-Fail") {
		case "after-commit":
			// The write commits, then the server fails.
			real.ServeHTTP(httptest.NewRecorder(), req)
			w.WriteHeader(http.StatusBadGateway)
		case "before-commit":
			w.WriteHeader(http.StatusInternalServerError)
		case "panic":
			panic("livesync test: inner panics")
		case "hot":
			livesyncHotDeferred(t)
			w.WriteHeader(http.StatusCreated)
		default:
			real.ServeHTTP(w, req)
		}
	})
	livesyncServeInner(t, map[string]string{"HOT_COALESCE": "1h"}, inner)
	livesyncSettle(t)
	token := livesyncToken(t, &user_model.User{ID: 2})
	const issues = "/api/v1/repos/user2/repo1/issues"
	record := func(t *testing.T, key string) livesync_model.Idempotency {
		t.Helper()
		var rec livesync_model.Idempotency
		has, err := db.GetEngine(t.Context()).Where("user_id = 2 AND idem_key = ?", key).Get(&rec)
		require.NoError(t, err)
		require.True(t, has)
		return rec
	}

	t.Run("5xx after the commit", func(t *testing.T) {
		body := map[string]any{"title": "idem 502", "body": "x"}
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "502", body).SetHeader("X-Test-Fail", "after-commit"), http.StatusBadGateway)
		rec := record(t, "502")
		assert.Equal(t, livesync_model.IdempotencyInFlight, rec.State)
		assert.Empty(t, rec.Owner, "released")
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem 502"))
		// The retry finds the issue the failed attempt created.
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "502", body), http.StatusCreated)
		var created livesyncIssueRef
		DecodeJSON(t, resp, &created)
		assert.Positive(t, created.ID)
		livesyncSyncID(t, resp)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem 502"))
		assert.Equal(t, livesync_model.IdempotencyCompleted, record(t, "502").State)
	})

	t.Run("5xx before the commit", func(t *testing.T) {
		body := map[string]any{"title": "idem 500"}
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "500", body).SetHeader("X-Test-Fail", "before-commit"), http.StatusInternalServerError)
		assert.Empty(t, record(t, "500").Owner)
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "500", body), http.StatusCreated)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem 500"))
	})

	t.Run("panic", func(t *testing.T) {
		body := map[string]any{"title": "idem panic"}
		assert.Panics(t, func() {
			MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "panic", body).SetHeader("X-Test-Fail", "panic"), NoExpectedStatus)
		})
		rec := record(t, "panic")
		assert.Equal(t, livesync_model.IdempotencyInFlight, rec.State)
		assert.Empty(t, rec.Owner, "released")
		MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "panic", body), http.StatusCreated)
		assert.EqualValues(t, 1, livesyncIssueCount(t, "idem panic"))
	})

	t.Run("deferred hot rows do not hold the wait", func(t *testing.T) {
		// The write's range holds a notification row the materializer
		// deferred for HOT_COALESCE (1 h): the sync id comes at once.
		start := time.Now()
		resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "hot", map[string]any{"title": "idem hot"}).SetHeader("X-Test-Fail", "hot"), http.StatusCreated)
		livesyncSyncID(t, resp)
		assert.Less(t, time.Since(start), 1500*time.Millisecond)
		_, err := db.GetEngine(t.Context()).Exec("DELETE FROM livesync_change")
		require.NoError(t, err)
	})
}

// livesyncHotDeferred changes notification 1 twice, the second time while
// the materializer's coalescing delay for it runs, and waits until that
// change is deferred.
func livesyncHotDeferred(t *testing.T) {
	ctx := context.Background()
	handled := func() bool { // every outbox row consumed or deferred
		for _, c := range livesyncOutbox(t) {
			if !c.Deferred {
				return false
			}
		}
		return true
	}
	_, err := db.GetEngine(ctx).Exec("UPDATE notification SET updated_unix = updated_unix + 1 WHERE id = 1")
	require.NoError(t, err)
	require.Eventually(t, handled, livesyncWait, 5*time.Millisecond)
	_, err = db.GetEngine(ctx).Exec("UPDATE notification SET updated_unix = updated_unix + 1 WHERE id = 1")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		rows := livesyncOutbox(t)
		return len(rows) > 0 && rows[len(rows)-1].Tbl == "notification" && handled()
	}, livesyncWait, 5*time.Millisecond)
}

// TestLivesyncIdempotencyLateMaterializer: with IDEMPOTENCY_SYNC_WAIT = 0
// and no materializer running (the test holds the writer lease), a keyed
// write answers without X-Livesync-Sync-Id and stores sync_id -1 with its
// outbox range; once the materializer runs, a replay computes the sync id,
// which covers the write, and stores it.
func TestLivesyncIdempotencyLateMaterializer(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	lease, err := livesync_model.TryLease(t.Context(), "livesync.writer")
	require.NoError(t, err)
	defer lease.Release()
	livesyncServeWith(t, map[string]string{"IDEMPOTENCY_SYNC_WAIT": "0s"})
	token := livesyncToken(t, &user_model.User{ID: 2})
	const issues = "/api/v1/repos/user2/repo1/issues"
	body := map[string]any{"title": "idem no materializer"}
	cursor := livesyncLogHead(t)

	resp := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "late-mat", body), http.StatusCreated)
	assert.NotContains(t, resp.Header(), protocol.HeaderSyncID)
	var created livesyncIssueRef
	DecodeJSON(t, resp, &created)
	var rec livesync_model.Idempotency
	_, err = db.GetEngine(t.Context()).Where("user_id = 2 AND idem_key = 'late-mat'").Get(&rec)
	require.NoError(t, err)
	assert.Equal(t, livesync_model.IdempotencyCompleted, rec.State)
	assert.EqualValues(t, -1, rec.SyncID)
	assert.Greater(t, rec.OutboxHigh, rec.OutboxLow)
	again := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "late-mat", body), http.StatusCreated)
	assert.NotContains(t, again.Header(), protocol.HeaderSyncID, "still not materialized")
	assert.Equal(t, "true", again.Header().Get(protocol.HeaderIdempotentReplay))

	// The writer role takes over (it retries the lease every 2 s).
	lease.Release()
	var syncID int64
	require.Eventually(t, func() bool {
		r := MakeRequest(t, livesyncKeyed(t, "POST", issues, token, "late-mat", body), http.StatusCreated)
		v := r.Header().Get(protocol.HeaderSyncID)
		if v == "" {
			return false
		}
		syncID, err = strconv.ParseInt(v, 10, 64)
		return err == nil
	}, 20*time.Second, 50*time.Millisecond)
	livesyncCovered(t, cursor, syncID, protocol.ModelIssue, created.ID)
	var stored livesync_model.Idempotency
	_, err = db.GetEngine(t.Context()).Where("user_id = 2 AND idem_key = 'late-mat'").Get(&stored)
	require.NoError(t, err)
	assert.Equal(t, syncID, stored.SyncID)
	assert.EqualValues(t, 1, livesyncIssueCount(t, "idem no materializer"))
}

// TestLivesyncIdempotencyPool: livesync pins two pooled connections (its
// instance lock and the writer lease) and needs one to work with: it
// refuses to start with MAX_OPEN_CONNS 2, and keyed writes work with 3.
func TestLivesyncIdempotencyPool(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	master, err := livesync_model.MasterXORMEngine()
	require.NoError(t, err)
	t.Cleanup(func() { master.DB().SetMaxOpenConns(setting.Database.MaxOpenConns) })

	master.DB().SetMaxOpenConns(2)
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})
	err = livesync_service.Init(context.Background())
	require.ErrorContains(t, err, "needs at least 3 database connections")
	assert.False(t, livesync_service.Running())

	master.DB().SetMaxOpenConns(livesync_model.MinOpenConns)
	livesyncServe(t)
	token := livesyncToken(t, &user_model.User{ID: 2})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- MakeRequest(t, livesyncKeyed(t, "POST", "/api/v1/repos/user2/repo1/issues", token, "pool", map[string]any{"title": "idem pool"}), NoExpectedStatus)
	}()
	select {
	case resp := <-done:
		assert.Equal(t, http.StatusCreated, resp.Code)
		livesyncSyncID(t, resp)
	case <-time.After(30 * time.Second):
		master.DB().SetMaxOpenConns(setting.Database.MaxOpenConns)
		t.Fatal("a keyed write with MAX_OPEN_CONNS 3 did not finish")
	}
}
