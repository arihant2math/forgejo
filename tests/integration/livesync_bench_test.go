// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"forgejo.org/models/db"
	"forgejo.org/tests"

	"github.com/stretchr/testify/require"
)

// Write-amplification micro-benchmark of the capture triggers (PLAN §4.3,
// recorded in next/IMPLEMENTATION.md B2 notes). Opt-in, it takes a while:
//
//	LIVESYNC_BENCH=2000 ./integrations.pgsql.test -test.run TestLivesyncCaptureWriteAmplification -test.v
//
// It times N autocommitted single-row INSERTs, UPDATEs and DELETEs on the
// tracked label table, and N INSERTs in one transaction, without and with
// the triggers installed.
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

	t.Logf("%s, %d rows per operation (%d outbox rows written)", livesyncDBVersion(t), n, rows)
	t.Logf("%-16s %12s %12s %9s", "operation", "without µs/op", "with µs/op", "overhead")
	for _, op := range []string{"insert", "update", "delete", "insert in 1 tx"} {
		a := float64(without[op].Microseconds()) / float64(n)
		b := float64(with[op].Microseconds()) / float64(n)
		t.Logf("%-16s %12.1f %12.1f %8.0f%%", op, a, b, (b/a-1)*100)
	}
}

func livesyncDBVersion(t *testing.T) string {
	var v string
	_, err := db.GetEngine(t.Context()).SQL("SELECT version()").Get(&v)
	require.NoError(t, err)
	return v
}
