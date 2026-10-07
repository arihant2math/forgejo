// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	livesync_service "forgejo.org/services/livesync"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// innerMarker is the fake upstream handler: it answers 299 so that tests can
// tell "served by inner" apart from anything livesync would answer.
var innerMarker = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(299)
})

func mockConfig(t *testing.T, ini string) {
	t.Helper()
	cfg, err := setting.NewConfigProviderFromData(ini)
	require.NoError(t, err)
	t.Cleanup(test.MockVariableValue(&setting.CfgProvider, cfg))
}

// TestWrapPassthrough covers the cases where Wrap must return the upstream
// handler itself without touching the database: disabled (the default), SQLite
// and invalid settings. None of these needs a database, so this is a plain
// unit test (the PG/MySQL cases are in tests/integration/livesync_wrap_test.go).
func TestWrapPassthrough(t *testing.T) {
	cases := []struct {
		name   string
		dbType setting.DatabaseType
		ini    string
	}{
		{"no section", "postgres", ""},
		{"disabled", "mysql", "[livesync]\nENABLED = false\n"},
		{"sqlite", "sqlite3", "[livesync]\nENABLED = true\n"},
		{"invalid install mode", "postgres", "[livesync]\nENABLED = true\nINSTALL_MODE = sometimes\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mockConfig(t, c.ini)
			defer test.MockVariableValue(&setting.Database.Type, c.dbType)()

			wrapped := Wrap(innerMarker)
			// innerMarker is a func value (not comparable); see
			// TestWrapReturnsInnerIdentity for the identity check.
			_, isOwn := wrapped.(*handler)
			assert.False(t, isOwn, "Wrap must return inner unchanged")
			assert.False(t, livesync_service.Running())

			rec := httptest.NewRecorder()
			wrapped.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/-/sync/health", nil))
			assert.Equal(t, 299, rec.Code, "with livesync off, /-/sync/* falls through to inner")
		})
	}
}

// TestWrapReturnsInnerIdentity checks Wrap(h) == h for a comparable handler.
func TestWrapReturnsInnerIdentity(t *testing.T) {
	mockConfig(t, "[livesync]\nENABLED = true\n")
	defer test.MockVariableValue(&setting.Database.Type, setting.DatabaseType("sqlite3"))()
	inner := &struct{ http.Handler }{innerMarker}
	assert.Same(t, inner, Wrap(inner))
}

func TestOwnPath(t *testing.T) {
	cases := []struct {
		sub, path, want string
		own             bool
	}{
		{"", "/-/sync/health", "/-/sync/health", true},
		{"", "/-/sync", "/-/sync", true},
		{"", "/-/next/assets/app.js", "/-/next/assets/app.js", true},
		{"", "/-/next", "/-/next", true},
		{"", "/-/syncx", "", false},
		{"", "/-/nextgen", "", false},
		{"", "/api/v1/version", "", false},
		{"", "/user/-/sync/health", "", false},
		{"", "/", "", false},
		{"/forge", "/forge/-/sync/health", "/-/sync/health", true},
		{"/forge", "/-/sync/health", "/-/sync/health", true}, // sub-path already stripped by the proxy
		{"/forge", "/forge/api/v1/version", "", false},
		{"/forge", "/forgex/-/sync/health", "", false},
	}
	for _, c := range cases {
		t.Run(c.sub+c.path, func(t *testing.T) {
			defer test.MockVariableValue(&setting.AppSubURL, c.sub)()
			got, own := ownPath(c.path)
			assert.Equal(t, c.own, own)
			assert.Equal(t, c.want, got)
		})
	}
}

// TestHandlerRouting exercises the dispatching handler that Wrap returns when
// livesync runs, without a database: livesync is not Running here, so health
// answers 503 — which still proves the request was served by livesync.
func TestHandlerRouting(t *testing.T) {
	h := &handler{inner: innerMarker, own: newRoutes()}
	cases := []struct {
		sub, method, path string
		want              int
	}{
		{"", http.MethodGet, "/-/sync/health", http.StatusServiceUnavailable},
		{"", http.MethodPost, "/-/sync/health", http.StatusMethodNotAllowed},
		{"", http.MethodGet, "/-/sync/nope", http.StatusNotFound},
		{"", http.MethodGet, "/-/next/nope", http.StatusNotFound},
		{"", http.MethodGet, "/api/v1/version", 299},
		{"", http.MethodGet, "/-/syncx", 299},
		{"", http.MethodGet, "/", 299},
		{"/forge", http.MethodGet, "/forge/-/sync/health", http.StatusServiceUnavailable},
		{"/forge", http.MethodGet, "/forge/api/v1/version", 299},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.sub+c.path, func(t *testing.T) {
			defer test.MockVariableValue(&setting.AppSubURL, c.sub)()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
			assert.Equal(t, c.want, rec.Code)
			if c.want == http.StatusServiceUnavailable {
				assert.JSONEq(t, `{"status":"stopped"}`, rec.Body.String())
				assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
			}
		})
	}
}
