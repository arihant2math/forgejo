// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"testing"
	"time"

	auth_model "forgejo.org/models/auth"
	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	system_model "forgejo.org/models/system"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func livesyncSkipSQLite(t *testing.T) {
	t.Helper()
	if setting.Database.Type.IsSQLite3() {
		t.Skip("livesync does not run on SQLite")
	}
}

func newProbeLabel(name string) *issues_model.Label {
	return &issues_model.Label{RepoID: 1, Name: name, Color: "#123456"}
}

func outboxEntry(tbl string, id int64, op string) string {
	return fmt.Sprintf("%s:%d:%s", tbl, id, op)
}

// Writes to a tracked table land in the outbox in the same transaction:
// insert/update/delete, multi-row statements, rollback, nested transactions;
// untracked tables do not.
func TestLivesyncCaptureOutbox(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()

	t.Run("insert update delete", func(t *testing.T) {
		l := newProbeLabel("livesync-probe")
		require.NoError(t, db.Insert(ctx, l))
		_, err := db.GetEngine(ctx).ID(l.ID).Cols("name").Update(&issues_model.Label{Name: "renamed"})
		require.NoError(t, err)
		_, err = db.DeleteByID[issues_model.Label](ctx, l.ID)
		require.NoError(t, err)
		assert.Equal(t, []string{
			outboxEntry("label", l.ID, "I"),
			outboxEntry("label", l.ID, "U"),
			outboxEntry("label", l.ID, "D"),
		}, livesyncTakeOutbox(t))
	})

	t.Run("multi-row statement", func(t *testing.T) {
		var ids []int64
		require.NoError(t, db.GetEngine(ctx).Table("label").Where("repo_id = ?", 1).Cols("id").OrderBy("id").Find(&ids))
		require.Greater(t, len(ids), 1)
		_, err := db.GetEngine(ctx).Exec("UPDATE label SET description = description WHERE repo_id = ?", 1)
		require.NoError(t, err)
		var want []string
		for _, id := range ids {
			want = append(want, outboxEntry("label", id, "U"))
		}
		assert.ElementsMatch(t, want, livesyncTakeOutbox(t))
	})

	t.Run("rollback", func(t *testing.T) {
		err := db.WithTx(ctx, func(ctx context.Context) error {
			if err := db.Insert(ctx, newProbeLabel("rolled-back")); err != nil {
				return err
			}
			assert.Len(t, livesyncOutboxInTx(ctx, t), 1, "the outbox row is written in the same transaction")
			return errors.New("roll back")
		})
		require.EqualError(t, err, "roll back")
		assert.Empty(t, livesyncTakeOutbox(t))
	})

	t.Run("nested transactions", func(t *testing.T) {
		a, b := newProbeLabel("outer"), newProbeLabel("inner")
		require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
			if err := db.Insert(ctx, a); err != nil {
				return err
			}
			return db.WithTx(ctx, func(ctx context.Context) error { return db.Insert(ctx, b) })
		}))
		assert.Equal(t, []string{outboxEntry("label", a.ID, "I"), outboxEntry("label", b.ID, "I")}, livesyncTakeOutbox(t))

		// The inner transaction is the outer one: its failure rolls both back.
		err := db.WithTx(ctx, func(ctx context.Context) error {
			if err := db.Insert(ctx, newProbeLabel("outer2")); err != nil {
				return err
			}
			return db.WithTx(ctx, func(ctx context.Context) error {
				if err := db.Insert(ctx, newProbeLabel("inner2")); err != nil {
					return err
				}
				return errors.New("inner fails")
			})
		})
		require.Error(t, err)
		assert.Empty(t, livesyncTakeOutbox(t))
	})

	t.Run("untracked table", func(t *testing.T) {
		require.NoError(t, db.Insert(ctx, &system_model.Notice{Type: system_model.NoticeRepository, Description: "livesync probe"}))
		assert.Empty(t, livesyncTakeOutbox(t))
	})

	t.Run("API v1 write", func(t *testing.T) {
		session := loginUser(t, "user2")
		token := getTokenForLoggedInUser(t, session, auth_model.AccessTokenScopeWriteIssue, auth_model.AccessTokenScopeWriteRepository)
		req := NewRequestWithJSON(t, "POST", "/api/v1/repos/user2/repo1/labels", map[string]string{"name": "via-api", "color": "#abcdef"}).AddTokenAuth(token)
		resp := MakeRequest(t, req, http.StatusCreated)
		var created struct{ ID int64 }
		DecodeJSON(t, resp, &created)
		assert.Contains(t, livesyncTakeOutbox(t), outboxEntry("label", created.ID, "I"))
	})
}

// livesyncOutboxInTx reads the outbox inside the caller's transaction.
func livesyncOutboxInTx(ctx context.Context, t *testing.T) []livesync_model.Change {
	t.Helper()
	var rows []livesync_model.Change
	require.NoError(t, db.GetEngine(ctx).OrderBy("id").Find(&rows))
	return rows
}

// The outbox reader delivers committed rows promptly, fills the hole a long
// transaction leaves when it commits after a later one, and gives up the hole
// of a transaction that never commits after HOLE_TIMEOUT.
func TestLivesyncCaptureReader(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()
	const holeTimeout = 2 * time.Second
	batches := newLivesyncBatches()
	livesyncStartReader(t, capture.Config{HoleTimeout: holeTimeout, SweepInterval: 500 * time.Millisecond}, batches)

	// Prompt delivery (doorbell: the in-process commit hook).
	l := newProbeLabel("prompt")
	start := time.Now()
	require.NoError(t, db.Insert(ctx, l))
	c, _ := batches.waitFor(t, "label", l.ID, 5*time.Second)
	t.Logf("commit → reader latency: %s", time.Since(start))
	assert.Equal(t, livesync_model.OpInsert, c.Op)

	// A long transaction takes an id, a later one commits first.
	long := livesyncMaster(t).NewSession()
	defer long.Close()
	require.NoError(t, long.Begin())
	lowLabel := newProbeLabel("long tx")
	_, err := long.Insert(lowLabel)
	require.NoError(t, err)
	high := newProbeLabel("after")
	require.NoError(t, db.Insert(ctx, high))
	highChange, cursor := batches.waitFor(t, "label", high.ID, 5*time.Second)
	assert.Less(t, cursor, highChange.ID, "the cursor stays below the open hole")
	batches.none(t, "label", lowLabel.ID, 300*time.Millisecond)
	require.NoError(t, long.Commit())
	lowChange, cursor := batches.waitFor(t, "label", lowLabel.ID, 5*time.Second)
	assert.Less(t, lowChange.ID, highChange.ID, "the lower id was committed after the higher one")
	assert.Equal(t, highChange.ID, cursor, "hole filled: the cursor catches up")

	// A transaction that never commits: its hole is given up after
	// HOLE_TIMEOUT and the cursor moves past it.
	never := livesyncMaster(t).NewSession()
	defer never.Close()
	require.NoError(t, never.Begin())
	_, err = never.Insert(newProbeLabel("never"))
	require.NoError(t, err)
	next := newProbeLabel("next")
	require.NoError(t, db.Insert(ctx, next))
	nextChange, cursor := batches.waitFor(t, "label", next.ID, 5*time.Second)
	assert.Less(t, cursor, nextChange.ID-1, "the uncommitted id is a hole")
	require.NoError(t, never.Rollback())
	time.Sleep(holeTimeout + 500*time.Millisecond)
	last := newProbeLabel("last")
	require.NoError(t, db.Insert(ctx, last))
	lastChange, cursor := batches.waitFor(t, "label", last.ID, 5*time.Second)
	assert.Equal(t, lastChange.ID, cursor, "the hole timed out")

	// Processed rows are gone and the cursor is stored.
	assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, 5*time.Second, 50*time.Millisecond)
	v, _, err := livesync_model.GetMeta(ctx, capture.MetaCursor)
	require.NoError(t, err)
	assert.Equal(t, fmt.Sprint(lastChange.ID), v)
}

// The doorbells: with polling effectively off, a write through Forgejo's
// engine wakes the reader through the commit hook, and on PostgreSQL a write
// from another connection (another instance) through LISTEN/NOTIFY. On MySQL
// writes from elsewhere are found by polling.
func TestLivesyncCaptureDoorbell(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()

	poll := time.Hour
	if setting.Database.Type.IsMySQL() {
		poll = 0 // the 100 ms default
	}
	batches := newLivesyncBatches()
	livesyncStartReader(t, capture.Config{PollInterval: poll}, batches)
	time.Sleep(300 * time.Millisecond) // let LISTEN start

	l := newProbeLabel("hook")
	require.NoError(t, db.Insert(ctx, l))
	batches.waitFor(t, "label", l.ID, 3*time.Second)

	// A write that bypasses xorm (and its hooks) entirely.
	name := "elsewhere"
	_, err := livesyncMaster(t).DB().DB.ExecContext(ctx, "INSERT INTO label (repo_id, name, color) VALUES (1, '"+name+"', '#000000')")
	require.NoError(t, err)
	var id int64
	_, err = livesyncMaster(t).SQL("SELECT id FROM label WHERE name = ?", name).Get(&id)
	require.NoError(t, err)
	start := time.Now()
	batches.waitFor(t, "label", id, 3*time.Second)
	t.Logf("write from another connection → reader: %s", time.Since(start))
}

// Dropping a trigger (as an upstream table rebuild does) makes the next start
// repair it in INSTALL_MODE auto and bump that table's schema epoch only;
// stale triggers are replaced and extra ones dropped.
func TestLivesyncCaptureRepair(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	ctx := t.Context()
	master := livesyncMaster(t)

	require.NoError(t, livesync_service.Init(ctx))
	require.True(t, livesync_service.Running())
	epochs := livesyncEpochs(t)
	require.Len(t, epochs, len(catalog.Tracked()), "the first install sets every epoch")
	for _, e := range epochs {
		assert.EqualValues(t, 1, e)
	}

	inspect := func() *capture.Status {
		st, err := capture.Inspect(ctx)
		require.NoError(t, err)
		return st
	}
	stateOf := func(st *capture.Status, table string) []capture.State {
		var res []capture.State
		for _, o := range st.Objects {
			if o.Table == table {
				res = append(res, o.State)
			}
		}
		return res
	}
	restart := func(wantRepaired ...string) {
		t.Helper()
		before := livesyncEpochs(t)
		livesync_router.Wrap(routers.NormalRoutes())
		require.True(t, livesync_service.Running(), "livesync did not start, see the log")
		assert.True(t, inspect().Healthy())
		after := livesyncEpochs(t)
		for table, e := range after {
			want := before[table]
			for _, r := range wantRepaired {
				if r == table {
					want++
				}
			}
			assert.Equal(t, want, e, "epoch of %s", table)
		}
	}

	// A missing trigger.
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON issue`)
		require.NoError(t, err)
		assert.Equal(t, []capture.State{capture.StateMissing}, stateOf(inspect(), "issue"))
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_issue_au")
		require.NoError(t, err)
		assert.Equal(t, []capture.State{capture.StateOK, capture.StateMissing, capture.StateOK}, stateOf(inspect(), "issue"))
	}
	assert.False(t, inspect().Healthy())
	restart("issue")

	// A stale trigger.
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`ALTER TABLE label DISABLE TRIGGER livesync_capture`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_label_ai")
		require.NoError(t, err)
		_, err = master.Exec("CREATE TRIGGER livesync_label_ai AFTER INSERT ON label FOR EACH ROW INSERT INTO livesync_change (tbl, row_id, op) VALUES ('label', NEW.id, 'X')")
		require.NoError(t, err)
	}
	st := inspect()
	assert.Contains(t, stateOf(st, "label"), capture.StateStale)
	for _, o := range st.Objects {
		if o.State == capture.StateStale {
			assert.NotEmpty(t, o.Detail)
		}
	}
	restart("label")

	// A stale PostgreSQL function affects every table.
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`CREATE OR REPLACE FUNCTION livesync_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`)
		require.NoError(t, err)
		assert.Equal(t, capture.StateStale, inspect().Objects[0].State)
		var all []string
		for _, tbl := range catalog.Tracked() {
			all = append(all, tbl.Name)
		}
		restart(all...)
	}

	// An extra livesync trigger on an untracked table is dropped.
	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`CREATE TRIGGER livesync_capture AFTER INSERT OR UPDATE OR DELETE ON notice FOR EACH ROW EXECUTE FUNCTION livesync_capture()`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("CREATE TRIGGER livesync_notice_ai AFTER INSERT ON notice FOR EACH ROW INSERT INTO livesync_change (tbl, row_id, op) VALUES ('notice', NEW.id, 'I')")
		require.NoError(t, err)
	}
	assert.Equal(t, []capture.State{capture.StateExtra}, stateOf(inspect(), "notice"))
	assert.True(t, inspect().Healthy(), "extras do not block serving")
	restart()
	assert.Empty(t, stateOf(inspect(), "notice"))

	// Captured changes still flow after all this (and the service's drain
	// consumer empties the outbox).
	l := newProbeLabel("after repair")
	require.NoError(t, db.Insert(ctx, l))
	assert.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, 5*time.Second, 50*time.Millisecond)
	v, _, err := livesync_model.GetMeta(ctx, capture.MetaCursor)
	require.NoError(t, err)
	assert.NotEqual(t, "0", v)
}

// INSTALL_MODE verify never changes triggers: with one missing, livesync does
// not start, Wrap passes through and the DDL is available; once a "DBA" ran
// it, livesync starts and bumps the epoch of the table that was broken.
func TestLivesyncCaptureVerifyMode(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})
	livesyncResetCapture(t)
	t.Cleanup(func() {
		livesync_service.Shutdown()
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	ctx := t.Context()
	master := livesyncMaster(t)
	require.NoError(t, livesync_service.Init(ctx))
	livesync_service.Shutdown()
	epochs := livesyncEpochs(t)

	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON comment`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_comment_ad")
		require.NoError(t, err)
	}
	livesyncConfig(t, map[string]string{"INSTALL_MODE": "verify"})

	err := livesync_service.Init(ctx)
	require.ErrorIs(t, err, capture.ErrNotInstalled)
	var nie *capture.NotInstalledError
	require.ErrorAs(t, err, &nie)
	require.NoError(t, nie.Cause)
	assert.False(t, livesync_service.Running())
	assert.Contains(t, err.Error(), "1 missing")
	stmts := nie.Status.Statements()
	require.Len(t, stmts, 2, "drop-if-exists + create of the one missing trigger")
	assert.Contains(t, stmts[1], "CREATE TRIGGER")
	assert.Contains(t, stmts[1], "comment")
	assert.Contains(t, nie.Status.Script(), stmts[1]+";\n")
	var missing []string
	for _, o := range nie.Status.Objects {
		if o.State != capture.StateOK {
			missing = append(missing, o.Table+"/"+string(o.State))
		}
	}
	assert.Equal(t, []string{"comment/missing"}, missing)

	// Wrap passes through: plain Forgejo.
	inner := routers.NormalRoutes()
	assert.Same(t, inner, livesync_router.Wrap(inner))
	assert.False(t, livesync_service.Running())
	defer test.MockVariableValue(&testWebRoutes, livesyncRoutes(inner))()
	MakeRequest(t, NewRequest(t, "GET", "/-/sync/health"), http.StatusNotFound)
	assert.Equal(t, epochs, livesyncEpochs(t), "verify mode changes nothing")

	// The DBA runs the DDL; verify mode now starts and bumps the epoch.
	for _, stmt := range stmts {
		_, err := master.Exec(stmt)
		require.NoError(t, err)
	}
	require.NoError(t, livesync_service.Init(ctx))
	assert.True(t, livesync_service.Running())
	want := maps.Clone(epochs)
	want["comment"]++
	assert.Equal(t, want, livesyncEpochs(t))
	v, _, err := livesync_model.GetMeta(ctx, capture.MetaPending)
	require.NoError(t, err)
	assert.Empty(t, v)
}

// The livesync catalog classifies every table Forgejo registers, and every
// tracked table has an auto-increment id primary key. A new upstream table
// fails this test until it is added to the tracked or the ignored list.
func TestLivesyncCatalogContract(t *testing.T) {
	unclassified, err := livesync_service.CheckCatalog()
	require.NoError(t, err)
	assert.Empty(t, unclassified, "add these tables to the tracked or ignored list in services/livesync/catalog")

	registered := db.GetTableNames().Values()
	unclassified, vanished := catalog.Classify(registered)
	assert.Empty(t, unclassified)
	assert.Empty(t, vanished, "remove these tables from services/livesync/catalog")
}

// Tracked tables have no database-level cascades: MySQL does not fire
// triggers for rows changed by foreign key actions, so a cascade would change
// rows behind the capture's back (Forgejo deletes related rows in Go).
func TestLivesyncCaptureNoCascades(t *testing.T) {
	livesyncSkipSQLite(t)
	type fk struct {
		Table  string `xorm:"'tbl'"`
		Name   string `xorm:"'cname'"`
		Delete string `xorm:"'del'"`
		Update string `xorm:"'upd'"`
	}
	var fks []fk
	schemaExpr := "DATABASE()"
	if setting.Database.Type.IsPostgreSQL() {
		schemaExpr = "current_schema()"
	}
	require.NoError(t, db.GetEngine(t.Context()).SQL(`SELECT tc.table_name AS tbl, rc.constraint_name AS cname, rc.delete_rule AS del, rc.update_rule AS upd
		FROM information_schema.referential_constraints rc
		JOIN information_schema.table_constraints tc
			ON tc.constraint_schema = rc.constraint_schema AND tc.constraint_name = rc.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
		WHERE rc.constraint_schema = `+schemaExpr).Find(&fks))
	require.NotEmpty(t, fks, "the query must see Forgejo's foreign keys")
	tracked := map[string]bool{}
	for _, tbl := range catalog.Tracked() {
		tracked[tbl.Name] = true
	}
	for _, f := range fks {
		if !tracked[f.Table] {
			continue
		}
		for _, rule := range []string{f.Delete, f.Update} {
			assert.Contains(t, []string{"NO ACTION", "RESTRICT"}, strings.ToUpper(rule), "foreign key %s on tracked table %s", f.Name, f.Table)
		}
	}
}
