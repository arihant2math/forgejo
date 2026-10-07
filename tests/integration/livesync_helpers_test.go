// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

// Shared helpers for the TestLivesync* integration tests (see
// next/IMPLEMENTATION.md §1.5 for how to run them on PostgreSQL and MySQL).

import (
	"net/http"
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/web"
	livesync_service "forgejo.org/services/livesync"

	chi "github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// livesyncHandlerRouter lets a plain http.Handler stand in for the chi.Router
// of a *web.Route: only ServeHTTP is ever called on testWebRoutes.
type livesyncHandlerRouter struct {
	chi.Router
	h http.Handler
}

func (r livesyncHandlerRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.h.ServeHTTP(w, req)
}

// livesyncRoutes adapts the http.Handler returned by livesync_router.Wrap to
// the *web.Route type of testWebRoutes, so that MakeRequest and
// onApplicationRun (real listener, Hijack works) serve through it:
//
//	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(livesync_router.Wrap(routers.NormalRoutes())))()
func livesyncRoutes(h http.Handler) *web.Route {
	if r, ok := h.(*web.Route); ok {
		return r // Wrap returned inner unchanged
	}
	return &web.Route{R: livesyncHandlerRouter{Router: chi.NewRouter(), h: h}}
}

// livesyncConfig sets [livesync] keys in the loaded app.ini for the duration
// of the test, and stops livesync at the end of the test so that later tests
// in the same binary run with plain Forgejo.
func livesyncConfig(t *testing.T, kv map[string]string) {
	t.Helper()
	sec := setting.CfgProvider.Section("livesync")
	for k, v := range kv {
		key := sec.Key(k)
		prev := key.String()
		key.SetValue(v)
		t.Cleanup(func() { sec.Key(k).SetValue(prev) })
	}
	t.Cleanup(livesync_service.Shutdown)
}

// livesyncTableNames returns the names of livesync's own tables.
func livesyncTableNames() []string {
	var names []string
	for _, bean := range livesync_model.Tables() {
		names = append(names, db.TableName(bean))
	}
	return names
}

// livesyncDropTables drops livesync's own tables, so that a test can prove
// that Init creates them.
func livesyncDropTables(t *testing.T) {
	t.Helper()
	master, err := db.GetMasterEngine(db.DefaultContext.(db.Engined).Engine())
	require.NoError(t, err)
	for _, name := range livesyncTableNames() {
		require.NoError(t, master.DropTables(name))
	}
}

// livesyncTableSchemas returns, for each livesync table, the schemas of the
// test database (PostgreSQL) or the test database itself (MySQL, where other
// databases on the same server, e.g. a dev instance's, are ignored) in which a
// table of that name exists.
func livesyncTableSchemas(t *testing.T) map[string][]string {
	t.Helper()
	query := "SELECT table_schema FROM information_schema.tables WHERE table_name = ?"
	if setting.Database.Type.IsMySQL() {
		query += " AND table_schema = DATABASE()"
	}
	res := map[string][]string{}
	for _, name := range livesyncTableNames() {
		var schemas []string
		require.NoError(t, db.GetEngine(t.Context()).SQL(query+" ORDER BY table_schema", name).Find(&schemas))
		res[name] = schemas
	}
	return res
}
