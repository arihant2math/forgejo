// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Data-layer benchmark (dev only; e2e/hydrate.bench.spec.ts runs it in
// Chromium): N issue summaries (+ one IssueLabel each) of one repository
// through the real code paths —
//   bootstrap: N NDJSON lines parsed, applied to the pool, replacement;
//   persist:   the persister writing them to IndexedDB;
//   hydrate:   a cold pool reading them back, by group (phase 1) and the
//              whole database (phase 2), plus the in-memory part alone;
//   query:     the issues of the repository through the index, and a
//              delta applied with a field observer, then persisted.

import {autorun} from 'mobx';
import {Hydrator} from '../../data/hydrate.ts';
import {deleteDatabase, openDatabase} from '../../data/idb.ts';
import {MetaCache} from '../../data/meta.ts';
import {Persister} from '../../data/persist.ts';
import {Pool} from '../../data/pool.ts';
import type {Issue} from '../../protocol/types.gen.ts';
import {load} from '../../sync/bootstrap.ts';

export interface BenchResult {
  n: number;
  bootstrapMs: number;
  ndjsonMB: number;
  persistMs: number;
  hydrateGroupMs: number;
  hydrateAllMs: number;
  loadOnlyMs: number;
  queryMs: number;
  deltaMs: number;
  /** Persisting one changed issue of the big group (one bucket rewritten). */
  deltaFlushMs: number;
  atoms: number;
}

const BENCH_USER = 999_999_999;

function issue(id: number): Issue {
  return {
    id, repo_id: 1, number: id, poster_id: 1 + (id % 97), original_author: '', original_author_id: 0,
    title: `Issue ${id}: something does not work when the thing happens`, content_version: 1, milestone_id: id % 7,
    priority: 0, state: id % 3 ? 'open' : 'closed', is_pull: id % 5 === 0, comments: id % 13, ref: '', pin_order: 0,
    is_locked: false, created_at: '2026-03-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z',
  };
}

function ndjson(n: number): string {
  const lines: string[] = [JSON.stringify({type: 'header', group: 'repo:1', watermark: 100, units: ['issues', 'pulls'], tier: 'full', schemas: {}})];
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({v: 100, g: 'repo:1', m: 'Issue', id: i, op: 'U', d: issue(i)}));
    lines.push(JSON.stringify({v: 100, g: 'repo:1', m: 'IssueLabel', id: i, op: 'U', d: {id: i, issue_id: i, label_id: i % 11}}));
  }
  lines.push(JSON.stringify({type: 'end', count: 2 * n, refs: []}));
  return lines.join('\n') + '\n';
}

export async function benchHydrate(n: number): Promise<BenchResult> {
  await deleteDatabase(BENCH_USER).catch(() => undefined);
  const body = ndjson(n);

  // Bootstrap: stream → parse → pool (+ replacement).
  const pool = new Pool();
  let t = performance.now();
  await load(pool, {
    endpoint: '', token: '', group: 'repo:1', heldUnits: undefined,
    fetch: () => Promise.resolve(new Response(new Blob([body]).stream())),
  });
  const bootstrapMs = performance.now() - t;

  // Persist.
  const db = await openDatabase(BENCH_USER);
  const persister = new Persister(db, pool, new MetaCache());
  t = performance.now();
  await persister.flush();
  const persistMs = performance.now() - t;

  // Hydrate a cold pool: by group, then everything.
  let cold = new Pool();
  let loadOnly = 0;
  const sink = (p: () => Pool) => new Hydrator(db, (m, recs) => {
    const t0 = performance.now();
    const pp = p();
    pp.batch(() => pp.load(m, recs));
    loadOnly += performance.now() - t0;
  });
  let h = sink(() => cold);
  t = performance.now();
  await h.groups(['repo:1']);
  const hydrateGroupMs = performance.now() - t;
  const loadOnlyMs = loadOnly;

  cold = new Pool();
  h = sink(() => cold);
  h.eager = true;
  t = performance.now();
  await h.rest();
  const hydrateAllMs = performance.now() - t;

  // Query and a delta under an observer.
  const issues = cold.model('Issue');
  t = performance.now();
  let open = 0;
  for (const e of issues.by('repo_id', 1)) if (e.get('state') === 'open') open++;
  const queryMs = performance.now() - t;
  const target = issues.get(1);
  let seen = '';
  const stop = autorun(() => {
    seen = target?.get('title') ?? '';
  });
  t = performance.now();
  cold.batch(() => cold.put('Issue', 1, 'repo:1', 101, {...issue(1), title: 'renamed'}));
  const deltaMs = performance.now() - t;
  stop();
  // The same change persisted from the original pool (its persister).
  pool.batch(() => pool.put('Issue', 2, 'repo:1', 101, {...issue(2), title: 'renamed'}));
  t = performance.now();
  await persister.flush();
  const deltaFlushMs = performance.now() - t;
  let atoms = 0;
  for (const e of issues.all()) atoms += e._atoms?.size ?? 0;

  persister.close();
  db.close();
  await deleteDatabase(BENCH_USER).catch(() => undefined);
  if (seen !== 'renamed' || open === 0) throw new Error('benchmark sanity check failed');
  return {
    n, bootstrapMs, ndjsonMB: body.length / 1e6, persistMs, hydrateGroupMs, hydrateAllMs, loadOnlyMs, queryMs, deltaMs, deltaFlushMs, atoms,
  };
}
