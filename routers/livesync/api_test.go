// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pull_model "forgejo.org/models/pull"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/services/livesync/protocol"

	chi "github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidSHA(t *testing.T) {
	sha1 := &repo_model.Repository{ObjectFormatName: "sha1"}
	sha256 := &repo_model.Repository{ObjectFormatName: "sha256"}
	full := "65f1bf27bc3bf70f64657658635e66094edbcb4d"
	assert.True(t, validSHA(sha1, full))
	assert.True(t, validSHA(&repo_model.Repository{}, full), "sha1 by default")
	assert.False(t, validSHA(sha256, full))
	assert.True(t, validSHA(sha256, strings.Repeat("0a", 32)))
	for _, s := range []string{"", "65f1bf2", "master", strings.ToUpper(full), full[:39] + "g", full + "0", "v1.0"} {
		assert.False(t, validSHA(sha1, s), s)
	}
}

func TestAPIWrite(t *testing.T) {
	assert.True(t, apiWrite(http.MethodPost, "/-/sync/api/projects/1/columns"))
	assert.True(t, apiWrite(http.MethodPatch, "/-/sync/api/issues/1/body"))
	assert.True(t, apiWrite(http.MethodPut, "/-/sync/api/issues/1/viewed"))
	assert.True(t, apiWrite(http.MethodDelete, "/-/sync/api/projects/1/columns/2"))
	assert.False(t, apiWrite(http.MethodPost, "/-/sync/api/markdown"), "previews write nothing")
	assert.False(t, apiWrite(http.MethodGet, "/-/sync/api/issues/1/viewed"))
	assert.False(t, apiWrite(http.MethodHead, "/-/sync/api/repos/1/blobs/x"))
}

func TestImmutable(t *testing.T) {
	for _, tc := range []struct {
		inm  string
		want bool
	}{
		{"", false},
		{`"abc"`, true},
		{`W/"abc"`, true},
		{`"x", "abc"`, true},
		{`*`, true},
		{`"abcd"`, false},
		{`abc`, false},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if tc.inm != "" {
			req.Header.Set("If-None-Match", tc.inm)
		}
		assert.Equal(t, tc.want, immutable(rec, req, "abc"), tc.inm)
		assert.Equal(t, protocol.CacheImmutable, rec.Header().Get("Cache-Control"))
		assert.Equal(t, "Authorization", rec.Header().Get("Vary"))
		assert.Equal(t, `"abc"`, rec.Header().Get("ETag"))
		if tc.want {
			assert.Equal(t, http.StatusNotModified, rec.Code)
		}
	}
}

func TestViewedFiles(t *testing.T) {
	assert.Equal(t, protocol.APIViewedFiles{PullID: 3, Files: map[string]string{}}, viewedFiles(3, nil, []string{"a"}))
	state := &pull_model.ReviewState{CommitSHA: "c", UpdatedFiles: map[string]pull_model.ViewedState{
		"viewed": pull_model.Viewed, "changed": pull_model.Viewed, "unviewed": pull_model.Unviewed, "marked": pull_model.HasChanged,
	}}
	assert.Equal(t, protocol.APIViewedFiles{PullID: 3, CommitSHA: "c", Files: map[string]string{
		"viewed": protocol.ViewedViewed, "changed": protocol.ViewedHasChanged, "unviewed": protocol.ViewedUnviewed, "marked": protocol.ViewedHasChanged,
	}}, viewedFiles(3, state, []string{"changed", "unviewed", "new"}), "only viewed files that changed are has_changed")
}

// TestStream: a streamed immutable response (diffs) is 200 with the
// immutable headers only when the source started; a source that fails
// before its first byte is a 500 without them, one that fails after it
// cuts the response (through Forgejo's protocol middlewares, which
// recover panics) so that the client sees an error, not a short body.
func TestStream(t *testing.T) {
	failure := errors.New("git failed")
	sources := map[string]func(io.Writer) error{
		"ok":    func(w io.Writer) error { _, err := io.WriteString(w, "diff --git a/x b/x\n"); return err },
		"empty": func(io.Writer) error { return nil },
		"early": func(io.Writer) error { return failure },
		"late": func(w io.Writer) error {
			if _, err := io.WriteString(w, strings.Repeat("+line\n", 20000)); err != nil {
				return err
			}
			return failure
		},
	}
	r := newRouter()
	r.Get(protocol.APIPrefix+"/stream/{source}", func(w http.ResponseWriter, req *http.Request) {
		a := &apiRequest{w: w, req: req, ctx: req.Context()}
		if !immutable(w, req, "etag") {
			a.stream("text/plain; charset=utf-8", sources[chi.URLParam(req, "source")])
		}
	})
	srv := httptest.NewServer(&handler{inner: innerMarker, own: r})
	defer srv.Close()
	get := func(source string) (*http.Response, []byte, error) {
		resp, err := srv.Client().Get(srv.URL + protocol.APIPrefix + "/stream/" + source)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		return resp, body, err
	}

	resp, body, err := get("ok")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "diff --git a/x b/x\n", string(body))
	assert.Equal(t, protocol.CacheImmutable, resp.Header.Get("Cache-Control"))
	assert.Equal(t, `"etag"`, resp.Header.Get("ETag"))
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))

	resp, body, err = get("empty")
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode, "an empty diff is a diff")
	assert.Empty(t, body)

	resp, _, err = get("early")
	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
	assert.Empty(t, resp.Header.Get("ETag"))

	// Every line was sent, git's error came after them: still not a
	// complete response.
	resp, _, err = get("late")
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.ErrorIs(t, err, io.ErrUnexpectedEOF, "the cut response is an error for the client, not a complete body")
}

func TestBlameETag(t *testing.T) {
	const commit = "65f1bf27bc3bf70f64657658635e66094edbcb4d"
	seen := map[string]bool{}
	for _, c := range []struct {
		path   string
		bypass bool
	}{{"a.txt", false}, {"a.txt", true}, {"a,b.txt", false}, {`a"b.txt`, false}, {"ä.txt", false}} {
		etag := blameETag(commit, c.path, c.bypass)
		assert.Regexp(t, "^[0-9a-f]{64}$", etag, "a valid entity tag")
		assert.False(t, seen[etag])
		seen[etag] = true
		// Listed with others in If-None-Match: still a match.
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("If-None-Match", `"x", "`+etag+`"`)
		assert.True(t, immutable(rec, req, etag), c.path)
	}
	assert.Len(t, seen, 5)
	assert.True(t, seen[blameETag(commit, "a.txt", false)], "deterministic")
}
