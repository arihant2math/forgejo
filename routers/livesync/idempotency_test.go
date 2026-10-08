// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/modules/json"
	"forgejo.org/modules/optional"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/services/authz"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKeyed(t *testing.T) {
	defer test.MockVariableValue(&setting.AppSubURL, "/sub")()
	cases := []struct {
		method, path string
		key          bool
		want         string
	}{
		{"POST", "/api/v1/repos/a/b/issues", true, "/api/v1/repos/a/b/issues"},
		{"PATCH", "//api/v1//repos/a/b/issues/1/", true, "/api/v1/repos/a/b/issues/1"},
		{"PUT", "/sub/api/v1/repos/a/b/issues/1/labels", true, "/api/v1/repos/a/b/issues/1/labels"},
		{"DELETE", "/api/v1/repos/a/b/issues/comments/3", true, "/api/v1/repos/a/b/issues/comments/3"},
		{"POST", "/api/v1/repos/a/b/issues", false, ""},
		{"GET", "/api/v1/repos/a/b/issues", true, ""},
		{"HEAD", "/api/v1/version", true, ""},
		{"POST", "/api/v1", true, ""},
		{"POST", "/api/v1x/y", true, ""},
		{"POST", "/api/forgejo/v1/version", true, ""},
		{"POST", "/user/login", true, ""},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		if c.key {
			req.Header.Set(protocol.HeaderIdempotencyKey, "k")
		}
		got, ok := keyed(req)
		assert.Equal(t, c.want != "", ok, "%s %s", c.method, c.path)
		assert.Equal(t, c.want, got, "%s %s", c.method, c.path)
	}
}

// Requests without the header (or not keyed writes to API v1) reach inner
// as they came: the same request and response writer, the body unread.
func TestKeyedPassthrough(t *testing.T) {
	var gotReq *http.Request
	var gotW http.ResponseWriter
	var gotBody string
	h := &handler{inner: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotReq, gotW = req, w
		b, _ := io.ReadAll(req.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
	}), own: newRoutes()}
	for _, c := range []struct {
		method, path string
		key          bool
	}{
		{"POST", "/api/v1/repos/a/b/issues", false},
		{"GET", "/api/v1/repos/a/b/issues", true},
		{"POST", "/user/settings", true},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(`{"title":"x"}`))
		if c.key {
			req.Header.Set(protocol.HeaderIdempotencyKey, "k")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		assert.Same(t, req, gotReq)
		assert.Equal(t, http.ResponseWriter(w), gotW)
		assert.JSONEq(t, `{"title":"x"}`, gotBody)
		assert.Equal(t, http.StatusCreated, w.Code)
		assert.Empty(t, w.Header().Get(protocol.HeaderSyncID))
	}
}

// Without a running livesync (stopped, or a unit test) a keyed write is
// refused, never run without its key being honoured.
func TestKeyedStopped(t *testing.T) {
	called := false
	h := &handler{inner: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }), own: newRoutes()}
	req := httptest.NewRequest("POST", "/api/v1/repos/a/b/issues", strings.NewReader(`{}`))
	req.Header.Set(protocol.HeaderIdempotencyKey, "k")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	assert.False(t, called)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Equal(t, "2", w.Header().Get("Retry-After"))
}

func TestRecorder(t *testing.T) {
	defer test.MockVariableValue(&maxResponseBody, 8)()

	// Buffered: nothing reaches the real writer.
	w := httptest.NewRecorder()
	r := newRecorder(w)
	r.Header().Set("Content-Type", "text/plain")
	r.WriteHeader(http.StatusCreated)
	r.WriteHeader(http.StatusOK) // ignored, like net/http
	_, _ = r.Write([]byte("1234"))
	_, _ = r.Write([]byte("5678"))
	assert.Equal(t, http.StatusCreated, r.code())
	assert.Equal(t, "12345678", r.body.String())
	assert.False(t, r.omitted)
	assert.Empty(t, w.Body.String())

	// Over the limit: streamed with the handler's status and headers.
	_, _ = r.Write([]byte("9"))
	assert.True(t, r.omitted)
	assert.True(t, r.streaming)
	assert.Equal(t, http.StatusCreated, w.Code)
	assert.Equal(t, "text/plain", w.Header().Get("Content-Type"))
	assert.Equal(t, "123456789", w.Body.String())

	// Without a real writer the rest is dropped.
	r = newRecorder(nil)
	_, _ = r.Write([]byte("123456789"))
	assert.Equal(t, http.StatusOK, r.code())
	assert.True(t, r.omitted)
	assert.Empty(t, r.body.String())
	assert.Equal(t, http.StatusOK, newRecorder(nil).code())
}

func TestStoredHeadersAndWriteResponse(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", "application/json;charset=utf-8")
	h.Add("Link", "<a>")
	h.Add("Link", "<b>")
	h.Set("Set-Cookie", "session=secret")
	h.Set("Date", "now")
	h.Set("Content-Length", "3")
	h.Set(protocol.HeaderSyncID, "1")
	stored := storedHeaders(h, false)
	var back http.Header
	require.NoError(t, json.Unmarshal([]byte(stored), &back))
	assert.Equal(t, http.Header{"Content-Type": {"application/json;charset=utf-8"}, "Link": {"<a>", "<b>"}}, back)
	require.NoError(t, json.Unmarshal([]byte(storedHeaders(h, true)), &back))
	assert.Equal(t, "true", back.Get(protocol.HeaderBodyOmitted))

	w := httptest.NewRecorder()
	writeResponse(w, back, http.StatusCreated, []byte(`{}`), 42, true)
	assert.Equal(t, http.StatusCreated, w.Code)
	assert.Equal(t, "42", w.Header().Get(protocol.HeaderSyncID))
	assert.Equal(t, "true", w.Header().Get(protocol.HeaderIdempotentReplay))
	assert.Equal(t, "2", w.Header().Get("Content-Length"))
	assert.Equal(t, []string{"<a>", "<b>"}, w.Header().Values("Link"))
	assert.Equal(t, `{}`, w.Body.String())

	// No sync id known; no body.
	w = httptest.NewRecorder()
	writeResponse(w, http.Header{}, http.StatusNoContent, nil, -1, false)
	assert.Equal(t, http.StatusNoContent, w.Code)
	assert.NotContains(t, w.Header(), protocol.HeaderSyncID)
	assert.NotContains(t, w.Header(), protocol.HeaderIdempotentReplay)
	assert.NotContains(t, w.Header(), "Content-Length")
}

func TestReadRequest(t *testing.T) {
	defer test.MockVariableValue(&setting.AppSubURL, "/sub")()
	for _, p := range []string{"/api/v1/repos/a/b/issues", "/sub/api/v1/repos/a/b/issues"} {
		req := httptest.NewRequest("POST", p+"?x=1", strings.NewReader(`{"title":"t"}`))
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(protocol.HeaderIdempotencyKey, "k")
		path, ok := keyed(req)
		require.True(t, ok)
		r := readRequest(req, path, "/repos/a/b/issues/7")
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, strings.TrimSuffix(p, "/repos/a/b/issues")+"/repos/a/b/issues/7", r.URL.Path)
		assert.Empty(t, r.URL.RawQuery)
		assert.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("Content-Type"))
		assert.Empty(t, r.Header.Get(protocol.HeaderIdempotencyKey))
		assert.Equal(t, "application/json", req.Header.Get("Content-Type"), "the original is unchanged")
		assert.Equal(t, http.NoBody, r.Body)
	}
}

type fakeRepo int64

func (r fakeRepo) GetTargetRepoID() int64 { return int64(r) }

func TestCredentialScope(t *testing.T) {
	scope := func(s string) optional.Option[auth_model.AccessTokenScope] {
		return optional.Some(auth_model.AccessTokenScope(s))
	}
	all := credentialScope(&fakeResult{scope: scope("all")})
	assert.Equal(t, all, credentialScope(&fakeResult{scope: scope("all"), reducer: &authz.AllAccessAuthorizationReducer{}}))
	// Equivalent spellings of a scope are the same credentials.
	assert.Equal(t,
		credentialScope(&fakeResult{scope: scope("write:issue,read:user")}),
		credentialScope(&fakeResult{scope: scope("read:user,write:issue")}))
	specific := credentialScope(&fakeResult{scope: scope("all"), reducer: &authz.SpecificReposAuthorizationReducer{ResourceRepos: []authz.RepoGetter{fakeRepo(3), fakeRepo(1)}}})
	assert.Equal(t, specific, credentialScope(&fakeResult{scope: scope("all"), reducer: &authz.SpecificReposAuthorizationReducer{ResourceRepos: []authz.RepoGetter{fakeRepo(1), fakeRepo(3)}}}))
	distinct := map[string]bool{}
	for _, s := range []string{
		all,
		credentialScope(&fakeResult{}),
		credentialScope(&fakeResult{scope: scope("write:issue")}),
		credentialScope(&fakeResult{scope: scope("all"), reducer: &authz.PublicReposAuthorizationReducer{}}),
		specific,
		credentialScope(&fakeResult{scope: scope("all"), reducer: &authz.SpecificReposAuthorizationReducer{ResourceRepos: []authz.RepoGetter{fakeRepo(1)}}}),
	} {
		assert.False(t, distinct[s], "%q twice", s)
		distinct[s] = true
	}
}
