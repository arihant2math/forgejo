// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	livesync_model "forgejo.org/models/livesync"
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
