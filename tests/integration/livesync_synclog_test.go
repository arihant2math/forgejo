// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"forgejo.org/models/db"
	livesync_model "forgejo.org/models/livesync"
	"forgejo.org/modules/setting"
	"forgejo.org/modules/test"
	livesync_service "forgejo.org/services/livesync"
	"forgejo.org/services/livesync/protocol"
	"forgejo.org/services/livesync/synclog"
	"forgejo.org/tests"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func livesyncTestEntry(id int64) synclog.Entry {
	return synclog.Entry{Group: "repo:1", Unit: protocol.UnitIssues, Model: protocol.ModelLabel, EntityID: id, Op: protocol.OpUpsert, Payload: "{}", SchemaVer: 1}
}

func livesyncAppend(ctx context.Context, w *synclog.Writer, entries ...synclog.Entry) (int64, error) {
	var first int64
	err := db.WithTx(ctx, func(ctx context.Context) error {
		var err error
		first, err = w.Append(ctx, entries)
		return err
	})
	return first, err
}

// livesyncKillWriterConnection terminates the database session holding the
// sync log writer lease, as a network failure would.
func livesyncKillWriterConnection(t *testing.T) {
	t.Helper()
	master := livesyncMaster(t)
	if setting.Database.Type.IsPostgreSQL() {
		var pids []int64
		require.NoError(t, master.SQL(`SELECT l.pid FROM pg_locks l
			WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
			  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
			  AND l.classid::bigint = ((hashtext('livesync.writer' || '.' || current_schema())::bigint >> 32) & 4294967295)
			  AND l.objid::bigint = (hashtext('livesync.writer' || '.' || current_schema())::bigint & 4294967295)`).Find(&pids))
		require.Len(t, pids, 1)
		_, err := master.Exec("SELECT pg_terminate_backend(?)", pids[0])
		require.NoError(t, err)
		return
	}
	var id int64
	has, err := master.SQL("SELECT IS_USED_LOCK(CONCAT('livesync.writer', '.', MD5(DATABASE())))").Get(&id)
	require.NoError(t, err)
	require.True(t, has)
	require.Positive(t, id)
	_, err = master.Exec(fmt.Sprintf("KILL %d", id))
	require.NoError(t, err)
}

// One writer at a time: a second instance cannot take the lease while the
// first holds it; it can once the first is gone; a writer whose lease was
// lost notices (Check) and is fenced off (ErrNotWriter).
func TestLivesyncSyncLogLease(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()

	t.Run("running instance holds it", func(t *testing.T) {
		livesyncStart(t, nil)
		// The writer role starts right away; wait until it took the lease
		// (its fencing token is set then).
		require.Eventually(t, func() bool {
			v, _, err := livesync_model.GetMeta(ctx, synclog.MetaWriter)
			require.NoError(t, err)
			return v == "1"
		}, livesyncWait, 20*time.Millisecond)
		_, err := synclog.AcquireWriter(ctx, nil)
		require.ErrorIs(t, err, synclog.ErrWriterHeld, "a second instance cannot take the lease")

		livesync_service.Shutdown()
		w, err := synclog.AcquireWriter(ctx, nil)
		require.NoError(t, err, "released at shutdown")
		w.Release()
	})

	t.Run("lost lease", func(t *testing.T) {
		livesyncResetCapture(t)
		t.Cleanup(func() { livesyncResetCapture(t) })
		first, err := synclog.AcquireWriter(ctx, nil)
		require.NoError(t, err)
		defer first.Release()
		require.NoError(t, first.Check(ctx))
		_, err = synclog.AcquireWriter(ctx, nil)
		require.ErrorIs(t, err, synclog.ErrWriterHeld)
		_, err = livesyncAppend(ctx, first, livesyncTestEntry(1))
		require.NoError(t, err)

		livesyncKillWriterConnection(t)
		require.Error(t, first.Check(ctx), "the writer notices")
		var second *synclog.Writer
		require.Eventually(t, func() bool {
			second, err = synclog.AcquireWriter(ctx, nil)
			return err == nil
		}, livesyncWait, 20*time.Millisecond, "another instance takes over")
		defer second.Release()

		_, err = livesyncAppend(ctx, first, livesyncTestEntry(2))
		require.ErrorIs(t, err, synclog.ErrNotWriter, "the old writer is fenced off")
		id, err := livesyncAppend(ctx, second, livesyncTestEntry(3))
		require.NoError(t, err)
		assert.EqualValues(t, 2, id)
	})
}

// A lease whose holder went silent (its host died without closing the
// connection) is freed by the database after LeaseIdleTimeout, not after
// hours (backend audit): here the holder stops pinging (keepalive off) and
// another session takes the lock once the server ended the idle one.
func TestLivesyncLeaseIdleTimeout(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	ctx := context.Background()
	defer test.MockVariableValue(&livesync_model.LeaseIdleTimeout, 2*time.Second)()
	defer test.MockVariableValue(&livesync_model.LeaseKeepalive, time.Hour)()
	silent, err := livesync_model.TryLease(ctx, "livesync.test.idle")
	require.NoError(t, err)
	defer silent.Release()
	_, err = livesync_model.TryLease(ctx, "livesync.test.idle")
	require.ErrorIs(t, err, livesync_model.ErrLeaseHeld)
	var taken *livesync_model.Lease
	start := time.Now()
	require.Eventually(t, func() bool {
		taken, err = livesync_model.TryLease(ctx, "livesync.test.idle")
		return err == nil
	}, 15*time.Second, 100*time.Millisecond, "the server ended the idle session")
	defer taken.Release()
	t.Logf("taken over after %s", time.Since(start).Round(100*time.Millisecond))
	require.Error(t, silent.Check(ctx), "the silent holder notices")

	// A holder that keeps pinging keeps its lease past the idle timeout.
	defer test.MockVariableValue(&livesync_model.LeaseKeepalive, 300*time.Millisecond)()
	alive, err := livesync_model.TryLease(ctx, "livesync.test.alive")
	require.NoError(t, err)
	defer alive.Release()
	time.Sleep(4 * time.Second)
	require.NoError(t, alive.Check(ctx))
	_, err = livesync_model.TryLease(ctx, "livesync.test.alive")
	require.ErrorIs(t, err, livesync_model.ErrLeaseHeld)
}

// Appends from concurrent transactions get gap-free, strictly increasing
// sync ids in commit order (the head row is locked until commit).
func TestLivesyncSyncLogConcurrentAppend(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncResetCapture(t)
	t.Cleanup(func() { livesyncResetCapture(t) })
	ctx := context.Background()
	w, err := synclog.AcquireWriter(ctx, nil)
	require.NoError(t, err)
	defer w.Release()

	const goroutines, txs = 8, 25
	errs := make(chan error, goroutines)
	for g := range goroutines {
		go func() {
			for i := range txs {
				id := int64(g*1000 + i)
				// Two entries per transaction, and some rolled back.
				err := db.WithTx(ctx, func(ctx context.Context) error {
					if _, err := w.Append(ctx, []synclog.Entry{livesyncTestEntry(id), livesyncTestEntry(id)}); err != nil {
						return err
					}
					if i%5 == 4 {
						return errRollback
					}
					return nil
				})
				if err != nil && !errors.Is(err, errRollback) {
					errs <- err
					return
				}
			}
			errs <- nil
		}()
	}
	for range goroutines {
		require.NoError(t, <-errs)
	}
	entries := livesyncLogSince(t, 0)
	require.Len(t, entries, goroutines*txs*4/5*2)
	for i, e := range entries {
		require.EqualValues(t, i+1, e.SyncID)
		if i%2 == 1 {
			assert.Equal(t, entries[i-1].EntityID, e.EntityID, "a transaction's entries are consecutive")
		}
	}
	assert.EqualValues(t, len(entries), livesyncLogHead(t))
}

var errRollback = errors.New("roll back")

// Retention trims old entries and beyond the row limit, and reports the
// oldest cursor it can still serve; older cursors get a TrimmedError.
func TestLivesyncSyncLogRetention(t *testing.T) {
	livesyncSkipSQLite(t)
	defer tests.PrepareTestEnv(t)()
	livesyncResetCapture(t)
	t.Cleanup(func() { livesyncResetCapture(t) })
	ctx := context.Background()
	w, err := synclog.AcquireWriter(ctx, nil)
	require.NoError(t, err)
	defer w.Release()
	for i := range 10 {
		_, err := livesyncAppend(ctx, w, livesyncTestEntry(int64(i)))
		require.NoError(t, err)
	}
	_, err = livesyncMaster(t).Exec("UPDATE livesync_log SET created_unix = ? WHERE sync_id <= 4", time.Now().Add(-40*24*time.Hour).Unix())
	require.NoError(t, err)

	floor, err := w.Trim(ctx, 30*24*time.Hour, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 4, floor)
	got, err := synclog.Floor(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 4, got, "the oldest available cursor is reported")
	assert.Len(t, livesyncLogSince(t, 4), 6)
	_, err = synclog.ReadSince(ctx, "repo:1", 3, 100)
	var trimmed *synclog.TrimmedError
	require.ErrorAs(t, err, &trimmed)
	assert.EqualValues(t, 4, trimmed.Floor)

	floor, err = w.Trim(ctx, 30*24*time.Hour, 3)
	require.NoError(t, err)
	assert.EqualValues(t, 7, floor)
	assert.Len(t, livesyncLogSince(t, 7), 3)
	n, err := livesyncMaster(t).Table("livesync_log").Count()
	require.NoError(t, err)
	assert.EqualValues(t, 3, n)
}
