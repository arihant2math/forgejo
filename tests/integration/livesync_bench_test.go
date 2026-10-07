// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"forgejo.org/models/db"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/tests"

	"github.com/stretchr/testify/require"
)

// Write-amplification micro-benchmark of the capture triggers (PLAN §4.3,
// recorded in next/IMPLEMENTATION.md B2 notes). Opt-in, it takes a while:
//
//	LIVESYNC_BENCH=2000 ./integrations.pgsql.test -test.run TestLivesyncCaptureWriteAmplification -test.v
//
// It times N autocommitted single-row INSERTs, UPDATEs and DELETEs on the
// tracked label table, and N INSERTs in one transaction: without triggers,
// with the triggers installed, and with the triggers and an outbox reader
// (doorbell included) draining the outbox concurrently, which is how
// livesync runs.
func TestLivesyncCaptureWriteAmplification(t *testing.T) {
	livesyncSkipSQLite(t)
	n, _ := strconv.Atoi(os.Getenv("LIVESYNC_BENCH"))
	if n <= 0 {
		t.Skip("set LIVESYNC_BENCH=<rows> to run the write-amplification benchmark")
	}
	defer tests.PrepareTestEnv(t)()
	ctx := t.Context()
	e := db.GetEngine(ctx)

	run := func() map[string]time.Duration {
		res := map[string]time.Duration{}
		_, err := e.Exec("DELETE FROM label WHERE name LIKE 'bench-%'")
		require.NoError(t, err)
		ids := make([]int64, 0, n)

		start := time.Now()
		for i := range n {
			_, err := e.Exec("INSERT INTO label (repo_id, name, color, description) VALUES (1, ?, '#000000', '')", fmt.Sprintf("bench-%d", i))
			require.NoError(t, err)
		}
		res["insert"] = time.Since(start)
		require.NoError(t, e.Table("label").Where("name LIKE 'bench-%'").Cols("id").Find(&ids))

		start = time.Now()
		for _, id := range ids {
			_, err := e.Exec("UPDATE label SET description = 'x' WHERE id = ?", id)
			require.NoError(t, err)
		}
		res["update"] = time.Since(start)

		start = time.Now()
		for _, id := range ids {
			_, err := e.Exec("DELETE FROM label WHERE id = ?", id)
			require.NoError(t, err)
		}
		res["delete"] = time.Since(start)

		start = time.Now()
		require.NoError(t, db.WithTx(ctx, func(ctx context.Context) error {
			for i := range n {
				if _, err := db.GetEngine(ctx).Exec("INSERT INTO label (repo_id, name, color, description) VALUES (1, ?, '#000000', '')", fmt.Sprintf("bench-tx-%d", i)); err != nil {
					return err
				}
			}
			return nil
		}))
		res["insert in 1 tx"] = time.Since(start)
		_, err = e.Exec("DELETE FROM label WHERE name LIKE 'bench-%'")
		require.NoError(t, err)
		return res
	}

	livesyncUninstallTriggers(t)
	run() // warm up
	without := run()
	livesyncInstallCapture(t)
	with := run()
	rows := len(livesyncOutbox(t))
	livesyncResetCapture(t)

	drain := &livesyncCountingConsumer{}
	ctx, cancel := context.WithCancel(context.Background())
	r, err := capture.Start(ctx, capture.Config{}, drain)
	require.NoError(t, err)
	withReader := run()
	require.Eventually(t, func() bool { return len(livesyncOutbox(t)) == 0 }, 30*time.Second, 10*time.Millisecond)
	cancel()
	require.True(t, r.Wait(10*time.Second))

	t.Logf("%s, %d rows per operation (%d outbox rows written; the reader consumed %d rows in %d batches)",
		livesyncDBVersion(t), n, rows, drain.rows.Load(), drain.batches.Load())
	t.Logf("%-16s %14s %14s %9s %18s %9s", "operation", "without µs/op", "triggers µs/op", "overhead", "+reader µs/op", "overhead")
	for _, op := range []string{"insert", "update", "delete", "insert in 1 tx"} {
		a := float64(without[op].Microseconds()) / float64(n)
		b := float64(with[op].Microseconds()) / float64(n)
		c := float64(withReader[op].Microseconds()) / float64(n)
		t.Logf("%-16s %14.1f %14.1f %8.0f%% %18.1f %8.0f%%", op, a, b, (b/a-1)*100, c, (c/a-1)*100)
	}
}

// livesyncCountingConsumer acknowledges every batch and counts them.
type livesyncCountingConsumer struct {
	batches, rows atomic.Int64
}

func (c *livesyncCountingConsumer) Consume(_ context.Context, b *capture.Batch) error {
	c.batches.Add(1)
	c.rows.Add(int64(len(b.Changes)))
	return nil
}

func livesyncDBVersion(t *testing.T) string {
	var v string
	_, err := db.GetEngine(t.Context()).SQL("SELECT version()").Get(&v)
	require.NoError(t, err)
	return v
}
