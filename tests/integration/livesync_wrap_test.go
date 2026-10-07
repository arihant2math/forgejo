// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"io"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ENABLED=false (the default): Wrap returns the upstream handler itself,
// touches no table, and /-/sync/* falls through to upstream (404).
func TestLivesyncWrapDisabled(t *testing.T) {
	defer tests.PrepareTestEnv(t)()
	if !setting.Database.Type.IsSQLite3() {
		livesyncDropTables(t)
	}
	livesyncConfig(t, map[string]string{"ENABLED": "false"})

	inner := routers.NormalRoutes()
	wrapped := livesync_router.Wrap(inner)
	assert.Same(t, inner, wrapped, "Wrap must return inner unchanged when disabled")
	assert.False(t, livesync_service.Running())
	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(wrapped))()

	MakeRequest(t, NewRequest(t, "GET", "/-/sync/health"), http.StatusNotFound)
	MakeRequest(t, NewRequest(t, "GET", "/-/next/anything"), http.StatusNotFound)
	MakeRequest(t, NewRequest(t, "GET", "/api/v1/version"), http.StatusOK)

	if !setting.Database.Type.IsSQLite3() {
		for name, schemas := range livesyncTableSchemas(t) {
			assert.Empty(t, schemas, "disabled livesync must not create %s", name)
		}
	}
}

// ENABLED=true on PostgreSQL / MySQL: Init creates livesync's tables (in the
// configured PostgreSQL SCHEMA), /-/sync/health is served by livesync, and
// everything else (here /api/v1/version) is still served by upstream, over a
// real listener too. On SQLite it must pass through like when disabled.
// (Invalid settings are covered by the unit tests in routers/livesync: they
// log an error, which the integration test logger reports.)
func TestLivesyncWrapEnabled(t *testing.T) {
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})

	if setting.Database.Type.IsSQLite3() {
		inner := routers.NormalRoutes()
		assert.Same(t, inner, livesync_router.Wrap(inner), "livesync must disable itself on SQLite")
		assert.False(t, livesync_service.Running())
		return
	}

	livesyncDropTables(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	wrapped := livesync_router.Wrap(routers.NormalRoutes())
	require.True(t, livesync_service.Running(), "livesync failed to start, see the log")
	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(wrapped))()

	// Tables were created by Init, in the configured schema only.
	var wantSchema string
	if setting.Database.Type.IsPostgreSQL() {
		wantSchema = setting.Database.Schema
		if wantSchema == "" {
			wantSchema = "public"
		}
	} else {
		_, err := db.GetEngine(t.Context()).SQL("SELECT DATABASE()").Get(&wantSchema)
		require.NoError(t, err)
	}
	for name, schemas := range livesyncTableSchemas(t) {
		assert.Equal(t, []string{wantSchema}, schemas, "table %s", name)
	}
	v, ok, err := livesync_model.GetMeta(t.Context(), livesync_service.MetaTablesVersion)
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, strconv.Itoa(livesync_service.TablesVersion), v)

	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		// In-process, through testWebRoutes.
		resp := MakeRequest(t, NewRequest(t, "GET", "/-/sync/health"), http.StatusOK)
		assert.JSONEq(t, `{"status":"ok"}`, resp.Body.String())
		assert.Equal(t, "no-store", resp.Header().Get("Cache-Control"))
		MakeRequest(t, NewRequest(t, "GET", "/-/sync/unknown"), http.StatusNotFound)
		MakeRequest(t, NewRequest(t, "GET", "/-/next/unknown"), http.StatusNotFound)
		MakeRequest(t, NewRequest(t, "POST", "/-/sync/health"), http.StatusMethodNotAllowed)
		MakeRequest(t, NewRequest(t, "GET", "/api/v1/version"), http.StatusOK)

		// Over the real listener.
		get := func(path string) (int, string) {
			r, err := http.Get(u.String() + path)
			require.NoError(t, err)
			defer r.Body.Close()
			b, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			return r.StatusCode, string(b)
		}
		code, body := get("-/sync/health")
		assert.Equal(t, http.StatusOK, code)
		assert.JSONEq(t, `{"status":"ok"}`, body)
		code, body = get("api/v1/version")
		assert.Equal(t, http.StatusOK, code)
		assert.Contains(t, body, `"version"`)

		// What the graceful-shutdown hook does: health reports it.
		livesync_service.Shutdown()
		MakeRequest(t, NewRequest(t, "GET", "/-/sync/health"), http.StatusServiceUnavailable)
		MakeRequest(t, NewRequest(t, "GET", "/api/v1/version"), http.StatusOK)
	})

	// A second Init (restart) keeps the existing tables and data.
	require.NoError(t, livesync_model.SetMeta(t.Context(), "restart_probe", "kept"))
	livesync_router.Wrap(routers.NormalRoutes())
	require.True(t, livesync_service.Running())
	v, ok, err = livesync_model.GetMeta(t.Context(), "restart_probe")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "kept", v)
}
