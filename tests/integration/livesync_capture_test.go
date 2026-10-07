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
	"forgejo.org/modules/cache"
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

// The doorbells, each on its own, with polling effectively off:
//   - PostgreSQL: LISTEN/NOTIFY is the only doorbell (no statement observer),
//     for this instance's autocommitted writes and transactions alike, and for
//     writes from another connection (another instance);
//   - MySQL: the statement observer on the master engine rings for an
//     autocommitted write and for a transaction's COMMIT; a write from another
//     connection rings nothing and waits for the poll.
//
// Latencies are measured from just before the write to the delivery.
func TestLivesyncCaptureDoorbell(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()

	batches := newLivesyncBatches()
	livesyncStartReader(t, capture.Config{PollInterval: time.Hour, SweepInterval: time.Hour}, batches)
	time.Sleep(300 * time.Millisecond) // let LISTEN start, and its initial ring pass

	// An autocommitted write through Forgejo's engine.
	l := newProbeLabel("autocommit")
	start := time.Now()
	require.NoError(t, db.Insert(ctx, l))
	batches.waitFor(t, "label", l.ID, 3*time.Second)
	t.Logf("autocommit write → reader: %s", time.Since(start))

	// A transaction: nothing before its COMMIT, delivered after it.
	inTx := newProbeLabel("in tx")
	start = time.Now()
	require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
		if err := db.Insert(ctx, inTx); err != nil {
			return err
		}
		// More statements in the same transaction, then a pause: the
		// row must not be delivered before COMMIT.
		if _, err := db.GetEngine(ctx).ID(inTx.ID).Cols("description").Update(&issues_model.Label{Description: "x"}); err != nil {
			return err
		}
		batches.none(t, "label", inTx.ID, 200*time.Millisecond)
		start = time.Now()
		return nil
	}))
	batches.waitFor(t, "label", inTx.ID, 3*time.Second)
	t.Logf("COMMIT → reader: %s", time.Since(start))

	// A write that bypasses xorm entirely (another instance).
	rawInsert := func(name string) int64 {
		t.Helper()
		_, err := livesyncMaster(t).DB().DB.ExecContext(ctx, "INSERT INTO label (repo_id, name, color) VALUES (1, '"+name+"', '#000000')")
		require.NoError(t, err)
		var id int64
		_, err = livesyncMaster(t).SQL("SELECT id FROM label WHERE name = ?", name).Get(&id)
		require.NoError(t, err)
		return id
	}
	if setting.Database.Type.IsPostgreSQL() {
		start = time.Now()
		id := rawInsert("elsewhere")
		batches.waitFor(t, "label", id, 3*time.Second)
		t.Logf("write from another connection → reader (NOTIFY): %s", time.Since(start))
		return
	}
	// MySQL: no doorbell for it (the SELECT above is not a write either)...
	id := rawInsert("elsewhere")
	batches.none(t, "label", id, 500*time.Millisecond)
	// ...until the next write through the engine rings, or the poll.
	l2 := newProbeLabel("next")
	require.NoError(t, db.Insert(ctx, l2))
	batches.waitFor(t, "label", id, 3*time.Second)

	// With the default poll interval (100 ms), polling alone finds it.
	batches2 := newLivesyncBatches()
	livesyncStartReader(t, capture.Config{}, batches2)
	// Past its start-up cycle, and half-way between two ticks.
	time.Sleep(250 * time.Millisecond)
	start = time.Now()
	id = rawInsert("polled")
	batches2.waitFor(t, "label", id, 3*time.Second)
	t.Logf("write from another connection → reader (100 ms poll, written ≈50 ms before a tick): %s", time.Since(start))
}

// The outbox is recreated (or truncated) while livesync is stopped: it is
// empty and its ids restart below the stored cursor. The next reader must
// still deliver new rows at once, not only from its sweep.
func TestLivesyncCaptureOutboxRecreated(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()

	// Many ids were used before; then the table is dropped and created
	// again, which resets its sequence / AUTO_INCREMENT.
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaCursor, "1000000"))
	master := livesyncMaster(t)
	require.NoError(t, livesync_model.WithSchemaLock(ctx, func(ctx context.Context) error {
		if err := master.DropTables(livesync_model.Change{}.TableName()); err != nil {
			return err
		}
		return livesync_model.SyncTables(ctx)
	}))

	batches := newLivesyncBatches()
	livesyncStartReader(t, capture.Config{PollInterval: time.Hour, SweepInterval: time.Hour}, batches)
	l := newProbeLabel("after recreate")
	require.NoError(t, db.Insert(ctx, l))
	c, cursor := batches.waitFor(t, "label", l.ID, 3*time.Second)
	assert.Less(t, c.ID, int64(1000), "the ids restarted")
	assert.Equal(t, c.ID, cursor)
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

		// A function CREATE OR REPLACE cannot fix (another return type;
		// such a function can have no triggers).
		_, err = master.Exec(`DROP FUNCTION livesync_capture() CASCADE`)
		require.NoError(t, err)
		_, err = master.Exec(`CREATE FUNCTION livesync_capture() RETURNS int LANGUAGE sql AS 'SELECT 1'`)
		require.NoError(t, err)
		st := inspect()
		assert.Equal(t, capture.StateStale, st.Objects[0].State)
		assert.Contains(t, st.Objects[0].Detail, "returns int4")
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

// A repair's epoch bump survives a failure between the repair DDL and the
// bump: the tables are recorded as pending before the DDL runs, so the next
// Ensure bumps them although it finds the triggers healthy (MySQL, where the
// DDL is committed), or repairs and bumps them (PostgreSQL, where the DDL is
// rolled back with the failed bump).
func TestLivesyncCaptureRepairDurableEpoch(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	ctx := t.Context()
	master := livesyncMaster(t)
	before := livesyncEpochs(t)

	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON issue`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_issue_ai")
		require.NoError(t, err)
	}
	// The bump fails after the DDL: the stored epoch is not a number.
	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"issue", "garbage"))
	_, err := capture.Ensure(ctx, true)
	require.ErrorContains(t, err, "not a number")
	require.NotErrorIs(t, err, capture.ErrNotInstalled)
	pending, _, err := livesync_model.GetMeta(ctx, capture.MetaPending)
	require.NoError(t, err)
	assert.Equal(t, "issue", pending, "the repaired table stays pending")
	st, err := capture.Inspect(ctx)
	require.NoError(t, err)
	assert.Equal(t, setting.Database.Type.IsMySQL(), st.Healthy(), "MySQL commits DDL at once, PostgreSQL rolled it back")

	require.NoError(t, livesync_model.SetMeta(ctx, capture.MetaEpochPrefix+"issue", "5"))
	report, err := capture.Ensure(ctx, true)
	require.NoError(t, err)
	assert.Equal(t, []string{"issue"}, report.Repaired)
	assert.Equal(t, map[string]int64{"issue": 6}, report.Epochs)
	assert.True(t, report.Status.Healthy())
	want := maps.Clone(before)
	want["issue"] = 6
	assert.Equal(t, want, livesyncEpochs(t))
	pending, _, err = livesync_model.GetMeta(ctx, capture.MetaPending)
	require.NoError(t, err)
	assert.Empty(t, pending)

	// Nothing left to do: no more bumps.
	report, err = capture.Ensure(ctx, true)
	require.NoError(t, err)
	assert.Empty(t, report.Repaired)
	assert.Equal(t, want, livesyncEpochs(t))
}

// The repair DDL does not wait for a table lock longer than DDLLockTimeout:
// with a long transaction on the table, Ensure fails cleanly (livesync
// would serve the classic UI) instead of hanging Init, and the next Ensure
// repairs and bumps the table.
func TestLivesyncCaptureRepairLockTimeout(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncInstallCapture(t)
	defer test.MockVariableValue(&capture.DDLLockTimeout, time.Second)()
	ctx := t.Context()
	master := livesyncMaster(t)
	before := livesyncEpochs(t)

	if setting.Database.Type.IsPostgreSQL() {
		_, err := master.Exec(`DROP TRIGGER livesync_capture ON label`)
		require.NoError(t, err)
	} else {
		_, err := master.Exec("DROP TRIGGER livesync_label_ai")
		require.NoError(t, err)
	}
	long := master.NewSession()
	defer long.Close()
	require.NoError(t, long.Begin())
	_, err := long.Insert(newProbeLabel("holds a lock"))
	require.NoError(t, err)

	start := time.Now()
	_, err = capture.Ensure(ctx, true)
	elapsed := time.Since(start)
	require.ErrorIs(t, err, capture.ErrNotInstalled)
	assert.Contains(t, err.Error(), "held its lock for longer than 1s")
	assert.Less(t, elapsed, 10*time.Second)
	t.Logf("Ensure gave up after %s", elapsed)
	pending, _, err := livesync_model.GetMeta(ctx, capture.MetaPending)
	require.NoError(t, err)
	assert.Equal(t, "label", pending)

	require.NoError(t, long.Rollback())
	report, err := capture.Ensure(ctx, true)
	require.NoError(t, err)
	assert.Equal(t, []string{"label"}, report.Repaired)
	want := maps.Clone(before)
	want["label"]++
	assert.Equal(t, want, livesyncEpochs(t))
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

// capture.WithQuietTx on a real database: writes made through contexts
// derived from fn's (as Forgejo code derives them) belong to the transaction
// (invisible to other connections until the commit, rolled back with it),
// and AfterTx hooks run once the commit is visible.
func TestLivesyncCaptureQuietTx(t *testing.T) {
	livesyncSkipSQLite(t)
	require.NoError(t, livesync_service.EnsureTables(t.Context()))
	const name = "quiet_tx_probe"
	_, err := livesyncMaster(t).Where("name = ?", name).Delete(&livesync_model.Meta{})
	require.NoError(t, err)
	derived := func(ctx context.Context) context.Context {
		ctx, cancel := context.WithTimeout(cache.WithCacheContext(ctx), time.Minute)
		t.Cleanup(cancel)
		return ctx
	}
	// outside reads the probe on another connection, without locking.
	outside := func() string {
		t.Helper()
		var m livesync_model.Meta
		has, err := livesyncMaster(t).Where("name = ?", name).Get(&m)
		require.NoError(t, err)
		if !has {
			return ""
		}
		return m.Value
	}

	injected := errors.New("injected")
	require.ErrorIs(t, capture.WithQuietTx(t.Context(), func(ctx context.Context) error {
		require.True(t, db.InTransaction(derived(ctx)))
		require.NoError(t, livesync_model.SetMeta(derived(ctx), name, "rolled back"))
		assert.Empty(t, outside(), "uncommitted")
		db.AfterTx(ctx, func() { t.Error("AfterTx hook of a rolled back transaction ran") })
		return injected
	}), injected)
	assert.Empty(t, outside(), "rolled back")

	var hookSaw string
	require.NoError(t, capture.WithQuietTx(t.Context(), func(ctx context.Context) error {
		require.NoError(t, livesync_model.SetMeta(derived(ctx), name, "committed"))
		assert.Empty(t, outside(), "uncommitted")
		db.AfterTx(ctx, func() { hookSaw = outside() })
		return nil
	}))
	assert.Equal(t, "committed", outside())
	assert.Equal(t, "committed", hookSaw, "AfterTx hooks run after the commit")
}
