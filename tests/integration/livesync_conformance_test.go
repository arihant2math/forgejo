// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package integration

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"forgejo.org/modules/json"
	"forgejo.org/modules/setting"

	"github.com/stretchr/testify/require"
)

// TestLivesyncConformance runs the headless TypeScript conformance suite
// (next/conformance, B10) against this harness's Forgejo with livesync
// serving, on the harness's database (PostgreSQL with its schema, MySQL),
// like tests/e2e runs Playwright. The suite reaches the database itself for
// the scenarios that break something on purpose (CONFORMANCE_SQL); the one
// that kills and restarts the server cannot run in-process and is skipped
// here — next/tools/dev-forgejo.sh conformance runs every scenario against
// a real binary. Skipped when next/node_modules is absent (npm --prefix next
// ci).
func TestLivesyncConformance(t *testing.T) {
	livesyncSkipSQLite(t)
	next := filepath.Join(setting.AppWorkPath, "next")
	if _, err := os.Stat(filepath.Join(next, "node_modules", ".bin", "vitest")); err != nil {
		t.Skip("next/node_modules is absent: run `npm --prefix next ci` to include the conformance suite")
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		t.Skip("npm is not installed")
	}
	livesyncServeWith(t, map[string]string{"MAX_REPLAY": "100", "TRIGGER_CHECK_INTERVAL": "2s"})
	onApplicationRun(t, func(t *testing.T, u *url.URL) {
		livesyncWaitBackfill(t)
		cmd := exec.Command(npm, "run", "test:conformance")
		cmd.Dir = next
		cmd.Env = append(livesyncConformanceEnv(t),
			"FORGEJO_URL="+strings.TrimSuffix(u.String(), "/"),
			"FORGEJO_ADMIN_USER=user1", "FORGEJO_ADMIN_PASSWORD=password", // fixtures
			"CONFORMANCE_MAX_REPLAY=100",
		)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		require.NoError(t, cmd.Run(), "the conformance suite failed (its output is above)")
	})
}

// livesyncConformanceEnv is the process environment without the suite's
// own variables, plus the database access the suite may use.
func livesyncConformanceEnv(t *testing.T) []string {
	t.Helper()
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "CONFORMANCE_") && !strings.HasPrefix(kv, "FORGEJO_") && !strings.HasPrefix(kv, "PG") {
			env = append(env, kv)
		}
	}
	d := setting.Database
	host, port, ok := strings.Cut(d.Host, ":")
	var argv []string
	switch {
	case d.Type.IsPostgreSQL():
		if !ok {
			port = "5432"
		}
		argv = []string{"psql", "-h", host, "-p", port, "-U", d.User, "-d", d.Name, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"}
		env = append(env, "CONFORMANCE_DB=pg", "PGPASSWORD="+d.Passwd)
		if d.Schema != "" {
			env = append(env, "PGOPTIONS=-c search_path="+d.Schema)
		}
	case d.Type.IsMySQL():
		if !ok {
			port = "3306"
		}
		name, _, _ := strings.Cut(d.Name, "?") // the harness appends DSN parameters
		argv = []string{"mysql", "--no-defaults", "-h", host, "-P", port, "-u" + d.User, "-N", "-B", "-n", name}
		env = append(env, "CONFORMANCE_DB=mysql", "MYSQL_PWD="+d.Passwd)
	}
	if argv != nil {
		if _, err := exec.LookPath(argv[0]); err != nil {
			t.Logf("%s is not installed: the scenarios that need the database are skipped", argv[0])
			return env
		}
		b, err := json.Marshal(argv)
		require.NoError(t, err)
		env = append(env, fmt.Sprintf("CONFORMANCE_SQL=%s", b))
	}
	return env
}
