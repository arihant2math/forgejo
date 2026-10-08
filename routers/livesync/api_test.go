// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	repo_model "forgejo.org/models/repo"
	"forgejo.org/services/livesync/protocol"

	"github.com/stretchr/testify/assert"
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
}
