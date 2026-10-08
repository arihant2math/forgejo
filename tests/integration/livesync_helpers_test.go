// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

// Shared helpers for the TestLivesync* integration tests (see
// next/IMPLEMENTATION.md §1.5 for how to run them on PostgreSQL and MySQL).

import (
	"context"
	"fmt"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/modules/web"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/materialize"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"

	"code.forgejo.org/xorm/xorm"
	chi "github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
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

// livesyncResetCapture empties the outbox, the sync log, the entity index and
// the idempotency records and forgets every state kept in livesync_meta
// (reader cursor, schema epochs, pending repairs, log head/writer/floor,
// handled epochs, backfill progress) except the tables version, creating
// livesync's tables if needed.
func livesyncResetCapture(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, livesync_service.EnsureTables(ctx))
	master := livesyncMaster(t)
	for _, table := range []string{"livesync_change", "livesync_log", "livesync_entity", "livesync_idempotency"} {
		_, err := master.Exec("DELETE FROM " + table)
		require.NoError(t, err)
	}
	_, err := master.Exec("DELETE FROM livesync_meta WHERE name <> ?", livesync_service.MetaTablesVersion)
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

// livesyncStart runs livesync (Init: tables, capture triggers, tailer,
// writer role with the materializer) for the duration of the test, on a
// clean outbox / sync log / entity index, with extra [livesync] settings.
// At the end livesync is shut down and the triggers are removed.
func livesyncStart(t *testing.T, kv map[string]string) {
	t.Helper()
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	settings := map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"}
	maps.Copy(settings, kv)
	livesyncConfig(t, settings)
	require.NoError(t, livesync_service.Init(context.Background()))
	require.True(t, livesync_service.Running())
}

// livesyncLogHead returns the sync log head.
func livesyncLogHead(t *testing.T) int64 {
	t.Helper()
	head, err := synclog.Head(context.Background())
	require.NoError(t, err)
	return head
}

// livesyncLogSince returns every sync log entry after cursor.
func livesyncLogSince(t *testing.T, cursor int64) []livesync_model.LogEntry {
	t.Helper()
	var all []livesync_model.LogEntry
	for {
		entries, err := synclog.ReadSince(context.Background(), "", cursor, 1000)
		require.NoError(t, err)
		all = append(all, entries...)
		if len(entries) < 1000 {
			return all
		}
		cursor = entries[len(entries)-1].SyncID
	}
}

// livesyncWaitLog waits until an entry after cursor matches, and returns it.
func livesyncWaitLog(t *testing.T, cursor int64, timeout time.Duration, match func(e *livesync_model.LogEntry) bool) livesync_model.LogEntry {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		for _, e := range livesyncLogSince(t, cursor) {
			if match(&e) {
				return e
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no matching sync log entry after %d within %s", cursor, timeout)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// livesyncEntry matches a log entry by model, entity id and op.
func livesyncEntry(model protocol.Model, id int64, op protocol.Op) func(e *livesync_model.LogEntry) bool {
	return func(e *livesync_model.LogEntry) bool {
		return e.Model == string(model) && e.EntityID == id && e.Op == string(op)
	}
}

// livesyncServe runs livesync through Wrap (Init: tables, triggers,
// tailer, writer) for the duration of the test, on a clean outbox / sync log
// / entity index, and serves MakeRequest through the wrapped handler.
func livesyncServe(t *testing.T) {
	t.Helper()
	livesyncServeWith(t, nil)
}

// livesyncServeWith is livesyncServe with extra [livesync] settings.
func livesyncServeWith(t *testing.T, kv map[string]string) {
	t.Helper()
	livesyncServeInner(t, kv, routers.NormalRoutes())
}

// livesyncServeInner is livesyncServeWith with another handler than
// Forgejo's as Wrap's inner (e.g. one that fails on purpose).
func livesyncServeInner(t *testing.T, kv map[string]string, inner http.Handler) {
	t.Helper()
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	settings := map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"}
	maps.Copy(settings, kv)
	livesyncConfig(t, settings)
	wrapped := livesync_router.Wrap(inner)
	require.True(t, livesync_service.Running(), "livesync failed to start, see the log")
	t.Cleanup(test.MockVariableValue(&testWebRoutes, livesyncRoutes(wrapped)))
}

// livesyncWaitBackfill waits until the entity index backfill of every
// tracked table is done (deletes of rows it has not indexed yet are not
// routed anywhere, see the B3 notes).
func livesyncWaitBackfill(t *testing.T) {
	t.Helper()
	assert.Eventually(t, func() bool {
		var metas []livesync_model.Meta
		require.NoError(t, db.GetEngine(t.Context()).Where("name LIKE ?", materialize.MetaBackfillPrefix+"%").Find(&metas))
		done := 0
		for _, m := range metas {
			if m.Value == "done" {
				done++
			}
		}
		return done == len(catalog.Tracked())
	}, livesyncWait, 20*time.Millisecond, "entity index backfill")
}

// livesyncToken creates an access token with every scope for user u
// (directly in the database: fixture users cannot all sign in).
func livesyncToken(t *testing.T, u *user_model.User) string {
	t.Helper()
	tok := &auth_model.AccessToken{UID: u.ID, Name: fmt.Sprintf("livesync-perm-%d", time.Now().UnixNano()), Scope: auth_model.AccessTokenScopeAll, ResourceAllRepos: true}
	require.NoError(t, auth_model.NewAccessToken(t.Context(), tok))
	return tok.Token
}

// livesyncSettle waits until the materializer has consumed every outbox
// row and the sync log head stopped moving (writes of earlier requests are
// all in the log).
func livesyncSettle(t *testing.T) {
	t.Helper()
	assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, livesyncWait, 10*time.Millisecond, "outbox drained")
	head := livesyncLogHead(t)
	assert.Eventually(t, func() bool {
		time.Sleep(100 * time.Millisecond)
		next := livesyncLogHead(t)
		stable := next == head && len(livesyncOutbox(t)) == 0
		head = next
		return stable
	}, livesyncWait, time.Millisecond, "sync log settled")
}
