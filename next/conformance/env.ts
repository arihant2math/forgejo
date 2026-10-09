// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the suite is told about the server under test (environment
// variables; next/tools/dev-forgejo.sh conformance sets all of them, the Go
// wrapper tests/integration/livesync_conformance_test.go the first three).
//
//   FORGEJO_URL              the server (required), e.g. http://127.0.0.1:3000
//   FORGEJO_ADMIN_USER       a site administrator (default dev) …
//   FORGEJO_ADMIN_PASSWORD   … and its password (default devdevdev1)
//   CONFORMANCE_MAX_REPLAY   the server's [livesync] MAX_REPLAY (replay_too_long)
//   CONFORMANCE_DB           pg | mysql: the dialect of CONFORMANCE_SQL
//   CONFORMANCE_SQL          JSON array: a command running the SQL on its stdin
//                            against the server's database (psql / mysql)
//   CONFORMANCE_KILL_CMD     shell command: SIGKILL the server (a crash)
//   CONFORMANCE_STOP_CMD     shell command: stop the server gracefully (SIGTERM)
//   CONFORMANCE_START_CMD    shell command: start it again (waits until ready)
//
// Scenarios that need a capability the run does not have are skipped (and
// say so); the core scenarios need only FORGEJO_URL.

function list(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string') || v.length === 0) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return v;
}

const db = process.env.CONFORMANCE_DB;
if (db !== undefined && db !== 'pg' && db !== 'mysql') throw new Error('CONFORMANCE_DB must be pg or mysql');

export const env = {
  url: (process.env.FORGEJO_URL ?? '').replace(/\/+$/, ''),
  adminUser: process.env.FORGEJO_ADMIN_USER ?? 'dev',
  adminPassword: process.env.FORGEJO_ADMIN_PASSWORD ?? 'devdevdev1',
  maxReplay: process.env.CONFORMANCE_MAX_REPLAY ? Number(process.env.CONFORMANCE_MAX_REPLAY) : undefined,
  db,
  sql: list('CONFORMANCE_SQL'),
  killCmd: process.env.CONFORMANCE_KILL_CMD,
  stopCmd: process.env.CONFORMANCE_STOP_CMD,
  startCmd: process.env.CONFORMANCE_START_CMD,
};

/** The run can reach the database (CONFORMANCE_SQL + CONFORMANCE_DB). */
export const canSQL = env.sql !== undefined && env.db !== undefined;
/** The run can crash and restart the server. */
export const canCrash = canSQL && !!env.killCmd && !!env.startCmd;
/** The run can stop the server gracefully and start it again. */
export const canRestart = !!env.stopCmd && !!env.startCmd;
