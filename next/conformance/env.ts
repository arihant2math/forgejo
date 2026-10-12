// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// CONFORMANCE_SQL is a JSON command array accepting SQL on stdin (psql/mysql).
// Scenarios requiring unavailable database or restart capabilities are skipped.

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

export const canSQL = env.sql !== undefined && env.db !== undefined;
export const canCrash = canSQL && !!env.killCmd && !!env.startCmd;
export const canRestart = !!env.stopCmd && !!env.startCmd;
