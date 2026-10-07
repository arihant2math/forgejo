// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

// Shared helpers for the TestLivesync* integration tests (see
// next/IMPLEMENTATION.md §1.5 for how to run them on PostgreSQL and MySQL).

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/web"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"

	"code.forgejo.org/xorm/xorm"
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
	// Capture triggers write to livesync_change: with them installed and the
	// table gone, every write to a tracked table would fail.
	livesyncUninstallTriggers(t)
	master := livesyncMaster(t)
	for _, name := range livesyncTableNames() {
		require.NoError(t, master.DropTables(name))
	}
}

// livesyncMaster returns the master xorm engine.
func livesyncMaster(t *testing.T) *xorm.Engine {
	t.Helper()
	master, err := db.GetMasterEngine(db.DefaultContext.(db.Engined).Engine())
	require.NoError(t, err)
	return master
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

// livesyncResetCapture empties the outbox and forgets the capture state kept
// in livesync_meta (reader cursor, schema epochs, pending repairs), creating
// livesync's tables if needed.
func livesyncResetCapture(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, livesync_service.EnsureTables(ctx))
	master := livesyncMaster(t)
	_, err := master.Exec("DELETE FROM livesync_change")
	require.NoError(t, err)
	_, err = master.Exec("DELETE FROM livesync_meta WHERE name = ? OR name = ? OR name LIKE ?",
		capture.MetaCursor, capture.MetaPending, capture.MetaEpochPrefix+"%")
	require.NoError(t, err)

	// Deleting rows does not reset the id sequence. Store the last assigned
	// id as the cursor, as a reader that processed everything would have:
	// otherwise a new reader sees the ids below the first new row as holes
	// and keeps its cursor below them until HOLE_TIMEOUT.
	probe := &livesync_model.Change{Tbl: "probe", Op: livesync_model.OpUpdate}
	_, err = master.Insert(probe)
	require.NoError(t, err)
	_, err = master.Exec("DELETE FROM livesync_change")
	require.NoError(t, err)
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaCursor, strconv.FormatInt(probe.ID, 10)))
}

// livesyncUninstallTriggers drops every livesync capture trigger (and the
// PostgreSQL trigger function) from the test database, so that later tests
// in the same binary (fixture reloads!) do not write to the outbox.
func livesyncUninstallTriggers(t *testing.T) {
	t.Helper()
	master := livesyncMaster(t)
	if setting.Database.Type.IsPostgreSQL() {
		var tables []string
		require.NoError(t, master.SQL(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname = 'livesync_capture'`).Find(&tables))
		for _, table := range tables {
			_, err := master.Exec(`DROP TRIGGER IF EXISTS livesync_capture ON "` + table + `"`)
			require.NoError(t, err)
		}
		_, err := master.Exec("DROP FUNCTION IF EXISTS livesync_capture()")
		require.NoError(t, err)
		return
	}
	var names []string
	require.NoError(t, master.SQL(`SELECT trigger_name FROM information_schema.triggers
		WHERE trigger_schema = DATABASE() AND trigger_name LIKE 'livesync!_%' ESCAPE '!'`).Find(&names))
	for _, name := range names {
		_, err := master.Exec("DROP TRIGGER IF EXISTS `" + name + "`")
		require.NoError(t, err)
	}
}

// livesyncInstallCapture installs the capture triggers for the duration of
// the test (on PostgreSQL / MySQL), with a clean outbox and capture state.
func livesyncInstallCapture(t *testing.T) {
	t.Helper()
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	report, err := capture.Ensure(context.Background(), true)
	require.NoError(t, err)
	require.True(t, report.Status.Healthy())
}

// livesyncOutbox returns the outbox rows, in id order.
func livesyncOutbox(t *testing.T) []livesync_model.Change {
	t.Helper()
	var rows []livesync_model.Change
	require.NoError(t, livesyncMaster(t).OrderBy("id").Find(&rows))
	return rows
}

// livesyncTakeOutbox returns the outbox rows as "tbl:row_id:op" (in id order)
// and empties the outbox.
func livesyncTakeOutbox(t *testing.T) []string {
	t.Helper()
	var res []string
	for _, c := range livesyncOutbox(t) {
		res = append(res, c.Tbl+":"+strconv.FormatInt(c.RowID, 10)+":"+c.Op)
	}
	_, err := livesyncMaster(t).Exec("DELETE FROM livesync_change")
	require.NoError(t, err)
	return res
}

// livesyncEpochs returns the schema epochs stored in livesync_meta.
func livesyncEpochs(t *testing.T) map[string]int64 {
	t.Helper()
	var metas []livesync_model.Meta
	require.NoError(t, livesyncMaster(t).Where("name LIKE ?", capture.MetaEpochPrefix+"%").Find(&metas))
	res := map[string]int64{}
	for _, m := range metas {
		v, err := strconv.ParseInt(m.Value, 10, 64)
		require.NoError(t, err)
		res[strings.TrimPrefix(m.Name, capture.MetaEpochPrefix)] = v
	}
	return res
}

// livesyncBatches is a capture.Consumer for tests: it records every batch.
type livesyncBatches struct {
	c chan *capture.Batch
}

func newLivesyncBatches() *livesyncBatches {
	return &livesyncBatches{c: make(chan *capture.Batch, 1024)}
}

func (b *livesyncBatches) Consume(_ context.Context, batch *capture.Batch) error {
	b.c <- batch
	return nil
}

// waitFor returns the first delivered change matching (tbl, rowID) and the
// cursor of its batch, failing the test after timeout. Other changes are
// dropped.
func (b *livesyncBatches) waitFor(t *testing.T, tbl string, rowID int64, timeout time.Duration) (livesync_model.Change, int64) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case batch := <-b.c:
			for _, c := range batch.Changes {
				if c.Tbl == tbl && c.RowID == rowID {
					return c, batch.Cursor
				}
			}
		case <-deadline:
			t.Fatalf("no change for %s %d within %s", tbl, rowID, timeout)
			return livesync_model.Change{}, 0
		}
	}
}

// none fails if any change for (tbl, rowID) is delivered within d.
func (b *livesyncBatches) none(t *testing.T, tbl string, rowID int64, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case batch := <-b.c:
			for _, c := range batch.Changes {
				if c.Tbl == tbl && c.RowID == rowID {
					t.Fatalf("unexpected change %+v", c)
				}
			}
		case <-deadline:
			return
		}
	}
}

// livesyncStartReader runs an outbox reader feeding consumer until the end
// of the test.
func livesyncStartReader(t *testing.T, cfg capture.Config, consumer capture.Consumer) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r, err := capture.Start(ctx, cfg, consumer)
	require.NoError(t, err)
	t.Cleanup(func() {
		cancel()
		require.True(t, r.Wait(10*time.Second))
	})
}
