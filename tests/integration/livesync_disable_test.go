// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
	user_model "forgejo.org/models/user"
	"forgejo.org/routers"
	livesync_router "forgejo.org/routers/livesync"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/catalog"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func livesyncInsertLabel(t *testing.T) int64 {
	t.Helper()
	l := &issues_model.Label{RepoID: 1, Name: fmt.Sprintf("kill-%d", time.Now().UnixNano()), Color: "#123456"}
	require.NoError(t, db.Insert(t.Context(), l))
	return l.ID
}

// The kill switch: ENABLED = false after livesync ran removes the capture
// triggers and empties the outbox (INSTALL_MODE auto), so nothing grows
// while livesync is off; enabling it again reinstalls them, bumps every
// schema epoch and writes re-bootstrap markers. In INSTALL_MODE verify the
// triggers are left to the DBA.
func TestLivesyncDisable(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()
	livesyncStart(t, nil)
	// The writer has handled the first install's epochs (a table without a
	// handled epoch gets no marker).
	livesyncWaitBackfill(t)
	livesyncInsertLabel(t)
	livesync_service.Shutdown()
	livesyncInsertLabel(t) // stays in the outbox: nothing drains it now
	require.NotEmpty(t, livesyncOutbox(t))
	epochs := livesyncEpochs(t)

	livesyncConfig(t, map[string]string{"ENABLED": "false"})
	inner := routers.NormalRoutes()
	assert.Same(t, inner, livesync_router.Wrap(inner), "disabled: plain Forgejo")
	st, err := capture.Inspect(ctx)
	require.NoError(t, err)
	assert.False(t, st.Installed(), "the triggers are gone")
	assert.Empty(t, livesyncOutbox(t), "the outbox is empty")
	livesyncInsertLabel(t)
	assert.Empty(t, livesyncOutbox(t), "and stays empty")
	assert.Equal(t, epochs, livesyncEpochs(t), "the epochs are bumped when the triggers come back")
	// Idempotent.
	assert.Same(t, inner, livesync_router.Wrap(inner))

	// Enabled again: every table is repaired, its epoch bumped, and the
	// writer tells clients to re-bootstrap.
	cursor := livesyncLogHead(t)
	livesyncConfig(t, map[string]string{"ENABLED": "true"})
	require.NoError(t, livesync_service.Init(ctx))
	st, err = capture.Inspect(ctx)
	require.NoError(t, err)
	assert.True(t, st.Healthy())
	after := livesyncEpochs(t)
	for _, tbl := range catalog.Tracked() {
		assert.Equal(t, epochs[tbl.Name]+1, after[tbl.Name], tbl.Name)
	}
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return protocol.Op(e.Op) == protocol.OpRebootstrap && e.Model == string(protocol.ModelLabel)
	})
	id := livesyncInsertLabel(t)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, id, protocol.OpUpsert))

	// INSTALL_MODE verify: Forgejo may not change the schema, the triggers
	// stay (the DDL that removes them is logged).
	livesync_service.Shutdown()
	livesyncConfig(t, map[string]string{"ENABLED": "false", "INSTALL_MODE": "verify"})
	assert.Same(t, inner, livesync_router.Wrap(inner))
	st, err = capture.Inspect(ctx)
	require.NoError(t, err)
	assert.True(t, st.Healthy(), "verify mode leaves the triggers")

	// Backend audit: the DBA runs the logged DDL, users write, the DBA
	// installs the triggers again before livesync is enabled. They are
	// healthy then, but the label written in between was never captured:
	// enabling (in verify mode) must still bump every epoch and tell
	// clients to re-bootstrap, which Disable arranged by recording every
	// table as pending.
	epochs = livesyncEpochs(t)
	master := livesyncMaster(t)
	for _, stmt := range st.UninstallStatements() {
		_, err := master.Exec(stmt)
		require.NoError(t, err)
	}
	gone, err := capture.Inspect(ctx)
	require.NoError(t, err)
	require.False(t, gone.Installed())
	livesyncInsertLabel(t) // not captured
	for _, stmt := range gone.Statements() {
		_, err := master.Exec(stmt)
		require.NoError(t, err)
	}
	cursor = livesyncLogHead(t)
	livesyncConfig(t, map[string]string{"ENABLED": "true", "INSTALL_MODE": "verify"})
	require.NoError(t, livesync_service.Init(ctx))
	after = livesyncEpochs(t)
	for _, tbl := range catalog.Tracked() {
		assert.Equal(t, epochs[tbl.Name]+1, after[tbl.Name], tbl.Name)
	}
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return protocol.Op(e.Op) == protocol.OpRebootstrap && e.Model == string(protocol.ModelLabel)
	})
}

// A running livesync puts back capture triggers that went away while it
// runs (another instance started with ENABLED = false, a DBA, a migration):
// the writer checks them every TRIGGER_CHECK_INTERVAL, reinstalls them,
// and the bumped epochs become re-bootstrap markers.
func TestLivesyncTriggerWatch(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()
	livesyncStart(t, map[string]string{"TRIGGER_CHECK_INTERVAL": "200ms"})
	livesyncWaitBackfill(t)
	livesyncSettle(t)
	cursor := livesyncLogHead(t)
	epochs := livesyncEpochs(t)

	// What a peer instance with ENABLED = false does.
	report, err := capture.Uninstall(ctx)
	require.NoError(t, err)
	assert.Positive(t, report.Dropped)
	assert.True(t, livesync_service.Running())

	assert.Eventually(t, func() bool {
		st, err := capture.Inspect(ctx)
		return err == nil && st.Healthy()
	}, livesyncWait, 50*time.Millisecond, "the triggers are back")
	assert.Eventually(t, func() bool {
		after := livesyncEpochs(t)
		for _, tbl := range catalog.Tracked() {
			if after[tbl.Name] != epochs[tbl.Name]+1 {
				return false
			}
		}
		return true
	}, livesyncWait, 50*time.Millisecond, "every epoch bumped once")
	livesyncWaitLog(t, cursor, livesyncWait, func(e *livesync_model.LogEntry) bool {
		return protocol.Op(e.Op) == protocol.OpRebootstrap && e.Model == string(protocol.ModelLabel)
	})
	id := livesyncInsertLabel(t)
	livesyncWaitLog(t, cursor, livesyncWait, livesyncEntry(protocol.ModelLabel, id, protocol.OpUpsert))
}

// Uninstalling while other connections write keeps outbox ids monotonic.
// On MySQL the DROP TRIGGER statements run one by one and TRUNCATE resets
// AUTO_INCREMENT: the counter must be put back above every id the
// remaining triggers assigned while the others were being dropped (B8
// review: it was read before the drops and went back by hundreds), or the
// rows captured once a running instance reinstalls the triggers get ids at
// or below its reader's cursor. The writer updates a user (the user table's
// triggers are among the last dropped) and records the outbox counter after
// each committed update.
func TestLivesyncUninstallMonotonicIDs(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()
	livesyncInstallCapture(t)

	var seen, writes atomic.Int64
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				done <- nil
				return
			default:
			}
			if _, err := db.GetEngine(ctx).ID(2).NoAutoTime().Incr("num_stars").Update(new(user_model.User)); err != nil {
				done <- err
				return
			}
			last, err := capture.LastAssignedID(ctx)
			if err != nil {
				done <- err
				return
			}
			if last > seen.Load() {
				seen.Store(last)
			}
			writes.Add(1)
		}
	}()
	require.Eventually(t, func() bool { return writes.Load() >= 20 }, livesyncWait, time.Millisecond, "the writer runs")
	before := writes.Load()
	report, err := capture.Uninstall(ctx)
	close(stop)
	require.NoError(t, <-done)
	require.NoError(t, err)
	assert.Positive(t, report.Dropped)
	assert.True(t, report.Cleared)
	t.Logf("%d updates during the uninstall", writes.Load()-before)
	assert.Empty(t, livesyncOutbox(t))

	last, err := capture.LastAssignedID(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, last, seen.Load(), "the outbox counter did not go back")

	// Installed again (what a running instance's trigger check does): the
	// next captured change has an id above every earlier one.
	_, err = capture.Ensure(ctx, true)
	require.NoError(t, err)
	id := livesyncInsertLabel(t)
	var rows []livesync_model.Change
	require.NoError(t, livesyncMaster(t).Where("tbl = ? AND row_id = ?", "label", id).Find(&rows))
	require.NotEmpty(t, rows)
	assert.Greater(t, rows[0].ID, seen.Load())
}
