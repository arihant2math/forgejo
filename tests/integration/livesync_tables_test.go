// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	livesync_service "forgejo.org/services/livesync"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// livesyncIndexes returns the names of the indexes on a livesync table.
func livesyncIndexes(t *testing.T, table string) []string {
	t.Helper()
	metas, err := livesyncMaster(t).DBMetas()
	require.NoError(t, err)
	for _, m := range metas {
		if m.Name != table {
			continue
		}
		var names []string
		for name := range m.Indexes {
			names = append(names, name)
		}
		sort.Strings(names)
		return names
	}
	t.Fatalf("table %s not found", table)
	return nil
}

// A binary older than the tables must refuse to start before it changes them:
// xorm's Sync would otherwise re-create indexes or alter columns of the newer
// layout first.
func TestLivesyncTablesDowngradeGuard(t *testing.T) {
	if setting.Database.Type.IsSQLite3() {
		t.Skip("livesync does not run on SQLite")
	}
	ctx := t.Context()
	require.NoError(t, livesync_service.EnsureTables(ctx))
	t.Cleanup(func() {
		require.NoError(t, livesync_model.SetMeta(context.Background(), livesync_service.MetaTablesVersion, strconv.Itoa(livesync_service.TablesVersion)))
		require.NoError(t, livesync_service.EnsureTables(context.Background()))
		assert.Equal(t, []string{"created_unix", "grp_sync"}, livesyncIndexes(t, "livesync_log"), "indexes restored")
	})

	// Simulate a newer layout: no indexes on livesync_log, a higher version.
	require.NoError(t, livesyncMaster(t).DropIndexes(&livesync_model.LogEntry{}))
	require.Empty(t, livesyncIndexes(t, "livesync_log"))
	newer := strconv.Itoa(livesync_service.TablesVersion + 1)
	require.NoError(t, livesync_model.SetMeta(ctx, livesync_service.MetaTablesVersion, newer))

	err := livesync_service.EnsureTables(ctx)
	require.ErrorContains(t, err, "newer than this binary")
	// Init runs the same step and stays stopped.
	livesyncConfig(t, map[string]string{"ENABLED": "true"})
	require.ErrorContains(t, livesync_service.Init(ctx), "newer than this binary")
	assert.False(t, livesync_service.Running())
	assert.Empty(t, livesyncIndexes(t, "livesync_log"), "the refused start must not have run Sync")
	v, _, err := livesync_model.GetMeta(ctx, livesync_service.MetaTablesVersion)
	require.NoError(t, err)
	assert.Equal(t, newer, v, "the stored version must not be overwritten")
}

// Several instances starting together on a fresh database: xorm's Sync is
// check-then-create, so without the schema lock most of them fail with
// "already exists" / "Duplicate key name".
func TestLivesyncTablesConcurrentEnsure(t *testing.T) {
	if setting.Database.Type.IsSQLite3() {
		t.Skip("livesync does not run on SQLite")
	}
	const instances = 6
	for round := range 3 {
		livesyncDropTables(t)
		var wg sync.WaitGroup
		errs := make([]error, instances)
		for i := range instances {
			wg.Go(func() { errs[i] = livesync_service.EnsureTables(t.Context()) })
		}
		wg.Wait()
		for i, err := range errs {
			require.NoError(t, err, "round %d, instance %d", round, i)
		}
		for name, schemas := range livesyncTableSchemas(t) {
			assert.Len(t, schemas, 1, "round %d: table %s", round, name)
		}
		v, ok, err := livesync_model.GetMeta(t.Context(), livesync_service.MetaTablesVersion)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, strconv.Itoa(livesync_service.TablesVersion), v)
	}

	// The lock is exclusive: never two holders at once.
	var holders, maxHolders atomic.Int32
	var wg sync.WaitGroup
	for range instances {
		wg.Go(func() {
			assert.NoError(t, livesync_model.WithSchemaLock(t.Context(), func(context.Context) error {
				n := holders.Add(1)
				for {
					m := maxHolders.Load()
					if n <= m || maxHolders.CompareAndSwap(m, n) {
						break
					}
				}
				time.Sleep(20 * time.Millisecond)
				holders.Add(-1)
				return nil
			}))
		})
	}
	wg.Wait()
	assert.EqualValues(t, 1, maxHolders.Load())
}

// SetMeta inside a transaction must survive losing the insert race to a
// concurrent transaction (on PostgreSQL a failed INSERT aborts the whole
// transaction, so an insert-then-update fallback cannot work there).
func TestLivesyncSetMetaRace(t *testing.T) {
	if setting.Database.Type.IsSQLite3() {
		t.Skip("livesync does not run on SQLite")
	}
	require.NoError(t, livesync_service.EnsureTables(t.Context()))

	for _, inTx := range []bool{true, false} {
		name := "race_probe_" + strconv.FormatBool(inTx)
		t.Run(name, func(t *testing.T) {
			_, err := livesyncMaster(t).Where("name = ?", name).Delete(&livesync_model.Meta{})
			require.NoError(t, err)

			competitor := livesyncMaster(t).NewSession()
			defer competitor.Close()
			require.NoError(t, competitor.Begin())
			_, err = competitor.Insert(&livesync_model.Meta{Name: name, Value: "competitor"})
			require.NoError(t, err)

			done := make(chan error, 1)
			go func() {
				set := func(ctx context.Context) error { return livesync_model.SetMeta(ctx, name, "mine") }
				if inTx {
					done <- db.WithTx(t.Context(), set)
				} else {
					done <- set(t.Context())
				}
			}()
			// Let SetMeta block on the competitor's uncommitted row, then
			// commit it so SetMeta loses the insert race.
			time.Sleep(300 * time.Millisecond)
			require.NoError(t, competitor.Commit())

			select {
			case err := <-done:
				require.NoError(t, err)
			case <-time.After(30 * time.Second):
				t.Fatal("SetMeta did not return")
			}
			v, ok, err := livesync_model.GetMeta(t.Context(), name)
			require.NoError(t, err)
			assert.True(t, ok)
			assert.Equal(t, "mine", v)
		})
	}
}
