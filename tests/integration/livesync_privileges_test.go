// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"os"
	"testing"

	"forgejo.org/models/db"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/tests"

	"code.forgejo.org/xorm/xorm"
	"code.forgejo.org/xorm/xorm/names"
	"github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncMySQLEngineAs opens an engine on the test database as another
// MySQL user, skipping the test if that user cannot connect.
func livesyncMySQLEngineAs(t *testing.T, user, passwd string) *xorm.Engine {
	t.Helper()
	restoreUser := test.MockVariableValue(&setting.Database.User, user)
	restorePasswd := test.MockVariableValue(&setting.Database.Passwd, passwd)
	dsn, err := setting.DBMasterConnStr()
	restorePasswd()
	restoreUser()
	require.NoError(t, err)
	eng, err := xorm.NewEngine("mysql", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = eng.Close() })
	eng.SetMapper(names.GonicMapper{})
	if err := eng.Ping(); err != nil {
		t.Skipf("cannot connect to MySQL as %s (next/tools/dev-db.sh creates it): %v", user, err)
	}
	return eng
}

// livesyncUseEngine makes eng Forgejo's database engine until the end of the
// test (or until the returned function is called).
func livesyncUseEngine(t *testing.T, eng *xorm.Engine) func() {
	t.Helper()
	prevCtx := db.DefaultContext
	prev := prevCtx.(db.Engined).Engine()
	db.SetDefaultEngine(context.Background(), eng)
	restored := false
	restore := func() {
		if !restored {
			restored = true
			db.SetDefaultEngine(context.Background(), prev)
			db.DefaultContext = prevCtx
		}
	}
	t.Cleanup(restore)
	return restore
}

// PLAN §4.3 privilege matrix on MySQL with binary logging on: a database user
// without SUPER (and log_bin_trust_function_creators = 0) cannot create
// triggers, so INSTALL_MODE=auto fails cleanly (classic UI, privilege hint,
// DDL available); once a privileged user ran the DDL, the same user starts
// livesync in verify mode, and in auto mode too since nothing needs repair.
func TestLivesyncCaptureMySQLPrivileges(t *testing.T) {
	if !setting.Database.Type.IsMySQL() {
		t.Skip("MySQL only")
	}
	defer tests.PrepareTestEnv(t)()
	root := livesyncMaster(t)
	var logBin, trust int
	_, err := root.SQL("SELECT @@log_bin, @@log_bin_trust_function_creators").Get(&logBin, &trust)
	require.NoError(t, err)
	if logBin != 1 || trust != 0 {
		t.Skipf("needs binary logging on and log_bin_trust_function_creators = 0 (have %d, %d)", logBin, trust)
	}
	user, passwd := "forgejo", "forgejo"
	if u := os.Getenv("TEST_MYSQL_UNPRIVILEGED_USER"); u != "" {
		user, passwd = u, os.Getenv("TEST_MYSQL_UNPRIVILEGED_PASSWORD")
	}
	var super int
	_, err = root.SQL("SELECT COUNT(*) FROM information_schema.user_privileges WHERE privilege_type = 'SUPER' AND grantee LIKE ?", "'"+user+"'@%").Get(&super)
	require.NoError(t, err)
	if super > 0 {
		t.Skipf("MySQL user %s has SUPER", user)
	}

	livesyncResetCapture(t)
	livesyncUninstallTriggers(t)
	t.Cleanup(func() {
		livesyncUninstallTriggers(t)
		livesyncResetCapture(t)
	})
	unprivileged := livesyncMySQLEngineAs(t, user, passwd)
	restore := livesyncUseEngine(t, unprivileged)
	ctx := t.Context()
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "auto"})
	t.Cleanup(livesync_service.Shutdown) // before the engine is restored

	// auto: fails cleanly and reports why.
	_, err = capture.Ensure(ctx, true)
	var nie *capture.NotInstalledError
	require.ErrorAs(t, err, &nie)
	var myErr *mysql.MySQLError
	require.ErrorAs(t, err, &myErr)
	assert.EqualValues(t, 1419, myErr.Number, "You do not have the SUPER privilege and binary logging is enabled")
	assert.Contains(t, err.Error(), "log_bin_trust_function_creators = 1")
	assert.Contains(t, err.Error(), "INSTALL_MODE = verify")
	assert.Len(t, nie.Status.Statements(), 2*3*len(catalog.Tracked()), "drop + create for every trigger")
	st, err := capture.Inspect(ctx)
	require.NoError(t, err)
	for _, o := range st.Objects {
		assert.Equal(t, capture.StateMissing, o.State, "nothing was created: %s", o.Name)
	}

	err = livesync_service.Init(ctx)
	require.ErrorIs(t, err, capture.ErrNotInstalled)
	require.ErrorAs(t, err, &myErr)
	assert.False(t, livesync_service.Running())
	inner := routers.NormalRoutes()
	assert.NotSame(t, inner, livesync_router.Wrap(inner), "Wrap serves the classic UI and the admin page (degraded)")
	assert.Equal(t, livesync_service.StateDegraded, livesync_service.State())

	// A privileged user (the DBA) runs the DDL.
	for _, stmt := range nie.Status.Statements() {
		_, err := root.Exec(stmt)
		require.NoError(t, err, stmt)
	}

	// verify: starts; the epochs of the tables found broken are bumped.
	livesyncConfig(t, map[string]string{"INSTALL_MODE": "verify"})
	require.NoError(t, livesync_service.Init(ctx))
	assert.True(t, livesync_service.Running())
	epochs := livesyncEpochs(t)
	assert.Len(t, epochs, len(catalog.Tracked()))
	for table, e := range epochs {
		assert.EqualValues(t, 1, e, table)
	}
	// The triggers run as the DBA's account, not Forgejo's: Inspect warns.
	st, err = capture.Inspect(ctx)
	require.NoError(t, err)
	assert.True(t, st.Healthy())
	require.Len(t, st.Warnings, 1)
	assert.Contains(t, st.Warnings[0], "are defined by root@")
	assert.Contains(t, st.Warnings[0], "not by Forgejo's account "+user+"@")
	assert.Contains(t, st.Warnings[0], "error 1449")

	// auto works too while nothing needs repair.
	livesyncConfig(t, map[string]string{"INSTALL_MODE": "auto"})
	require.NoError(t, livesync_service.Init(ctx))
	assert.True(t, livesync_service.Running())
	assert.Equal(t, epochs, livesyncEpochs(t))

	// Writes by the unprivileged user are captured (the triggers run with
	// their definer's rights).
	livesync_service.Shutdown()
	l := newProbeLabel("unprivileged")
	require.NoError(t, db.Insert(ctx, l))
	assert.Contains(t, livesyncTakeOutbox(t), outboxEntry("label", l.ID, "I"))
	restore()
}

// With statement-based binary logging the capture triggers' AUTO_INCREMENT
// inserts are unsafe for replication: Inspect warns (it does not refuse).
func TestLivesyncCaptureMySQLStatementBinlog(t *testing.T) {
	if !setting.Database.Type.IsMySQL() {
		t.Skip("MySQL only")
	}
	defer tests.PrepareTestEnv(t)()
	var logBin int
	_, err := livesyncMaster(t).SQL("SELECT @@log_bin").Get(&logBin)
	require.NoError(t, err)
	if logBin != 1 {
		t.Skip("needs binary logging on")
	}
	livesyncInstallCapture(t)

	st, err := capture.Inspect(t.Context())
	require.NoError(t, err)
	assert.Empty(t, st.Warnings, "ROW/MIXED and triggers defined by Forgejo's own account")

	// An engine whose connections use binlog_format = STATEMENT (set by the
	// driver on connect; needs a privileged user, like the test's).
	dsn, err := setting.DBMasterConnStr()
	require.NoError(t, err)
	eng, err := xorm.NewEngine("mysql", dsn+"&binlog_format=%27STATEMENT%27")
	require.NoError(t, err)
	t.Cleanup(func() { _ = eng.Close() })
	eng.SetMapper(names.GonicMapper{})
	require.NoError(t, eng.Ping())
	livesyncUseEngine(t, eng)
	st, err = capture.Inspect(t.Context())
	require.NoError(t, err)
	assert.True(t, st.Healthy())
	require.Len(t, st.Warnings, 1)
	assert.Contains(t, st.Warnings[0], "binlog_format is STATEMENT")
}
