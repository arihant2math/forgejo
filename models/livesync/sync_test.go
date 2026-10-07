// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync_test

import (
	"context"
	"testing"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/models/unittest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The tables are only ever used on PostgreSQL and MySQL (covered by
// tests/integration/livesync_wrap_test.go); this checks on the unit-test
// SQLite database that the xorm definitions are valid, that SyncTables is
// idempotent and that the meta helpers upsert.
func TestSyncTablesAndMeta(t *testing.T) {
	require.NoError(t, unittest.PrepareTestDatabase())
	ctx := t.Context()

	require.NoError(t, livesync_model.SyncTables(ctx))
	require.NoError(t, livesync_model.SyncTables(ctx), "SyncTables must be idempotent")

	var names []string
	for _, bean := range livesync_model.Tables() {
		names = append(names, db.TableName(bean))
	}
	assert.Equal(t, []string{"livesync_change", "livesync_log", "livesync_entity", "livesync_meta", "livesync_idempotency"}, names)
	for _, name := range names {
		exist, err := db.GetEngine(ctx).IsTableExist(name)
		require.NoError(t, err)
		assert.True(t, exist, name)
		assert.False(t, db.GetTableNames().Contains(name), "%s must not be a registered upstream model", name)
	}

	_, ok, err := livesync_model.GetMeta(ctx, "k")
	require.NoError(t, err)
	assert.False(t, ok)

	for _, v := range []string{"1", "2", "2", ""} {
		require.NoError(t, livesync_model.SetMeta(ctx, "k", v))
		got, ok, err := livesync_model.GetMeta(ctx, "k")
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, v, got)
	}
	n, err := db.GetEngine(ctx).Count(&livesync_model.Meta{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, n)

	// MasterEngine works inside a transaction (returns the tx session).
	require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
		return livesync_model.SetMeta(ctx, "in_tx", "yes")
	}))
	got, ok, err := livesync_model.GetMeta(ctx, "in_tx")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "yes", got)
}
