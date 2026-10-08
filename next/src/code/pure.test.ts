// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import {describe, expect, test} from 'vitest';
import {parseAnsi} from './ansi.ts';
import {keyRepo, MemoryLru, toEvict} from './cache.ts';
import {langOf} from './lang.ts';
import {applyLog, emptyLog, stepOf} from './logs.ts';
import {codeSplat, isSha, parseCodePath, resolveName, resolveRef, type RefTable, withEnd} from './refs.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('LRU', () => {
  test('toEvict drops least recently used entries until the rest fits', () => {
    const e = [
      {key: 'x', atime: 3, size: 40, repo: 1},
      {key: 'y', atime: 1, size: 30, repo: 1},
      {key: 'z', atime: 2, size: 50, repo: 2},
    ];
    expect(toEvict(e, 200)).toEqual([]);
    expect(toEvict(e, 100)).toEqual(['y']);
    expect(toEvict(e, 50)).toEqual(['y', 'z']);
    expect(toEvict(e, 0)).toEqual(['y', 'z', 'x']);
  });

  test('property: what stays fits the budget and is newer than what goes', () => {
    fc.assert(fc.property(fc.array(fc.record({atime: fc.nat(1000), size: fc.nat(100)}), {maxLength: 50}), fc.nat(2000), (raw, budget) => {
      const entries = raw.map((r, i) => ({...r, key: `k${String(i)}`, repo: 1}));
      const gone = new Set(toEvict(entries, budget));
      const kept = entries.filter((e) => !gone.has(e.key));
      const total = (es: typeof entries) => es.reduce((n, e) => n + e.size, 0);
      expect(total(kept) <= budget || gone.size === entries.length).toBe(true);
      const newestGone = Math.max(-1, ...entries.filter((e) => gone.has(e.key)).map((e) => e.atime));
      for (const k of kept) expect(k.atime >= newestGone).toBe(true);
    }));
  });

  test('MemoryLru keeps the most recently used within its budget', () => {
    const m = new MemoryLru<string>(10);
    m.set('a', 'A', 4);
    m.set('b', 'B', 4);
    expect(m.get('a')).toBe('A'); // a is now the newest
    m.set('c', 'C', 4);
    expect(m.has('b')).toBe(false);
    expect([m.has('a'), m.has('c'), m.size]).toEqual([true, true, 8]);
    m.set('huge', 'H', 11);
    expect(m.has('huge')).toBe(false);
    m.deleteWhere((k) => k === 'a');
    expect(m.size).toBe(4);
  });

  test('cache keys name their repository', () => {
    expect(keyRepo(`tree:12:${A}:src`)).toBe(12);
    expect(keyRepo('log:7:99')).toBe(7);
  });
});

describe('ANSI', () => {
  test('SGR colours and bold, reset, other escapes dropped', () => {
    expect(parseAnsi('plain')).toEqual([{text: 'plain', color: 0, bold: false}]);
    expect(parseAnsi('\x1b[31merror\x1b[0m ok')).toEqual([{text: 'error', color: 1, bold: false}, {text: ' ok', color: 0, bold: false}]);
    expect(parseAnsi('\x1b[1;92mPASS\x1b[22m x\x1b[39m')).toEqual([{text: 'PASS', color: 2, bold: true}, {text: ' x', color: 2, bold: false}]);
    expect(parseAnsi('\x1b]0;title\x07a\x1b[2Kb\x1b[38;5;196mc')).toEqual([{text: 'abc', color: 0, bold: false}]);
    expect(parseAnsi('')).toEqual([]);
  });

  test('carriage returns keep the last state; controls are removed', () => {
    expect(parseAnsi('10%\r50%\r100%')).toEqual([{text: '100%', color: 0, bold: false}]);
    expect(parseAnsi('a\x07b\x00c')).toEqual([{text: 'abc', color: 0, bold: false}]);
    expect(parseAnsi('<script>alert(1)</script>')[0]?.text).toBe('<script>alert(1)</script>');
  });
});

describe('log buffer', () => {
  const line = (c: string) => ({t: 0, c});
  test('appends, dedupes repeats, reports gaps, resets on a new task', () => {
    const s = emptyLog();
    expect(applyLog(s, {task_id: 0, offset: 0, lines: []})).toEqual({ok: true, added: 0, reset: false});
    expect(applyLog(s, {task_id: 5, offset: 0, lines: [line('a'), line('b')], steps: [{name: 's', status: 'running', log_index: 0, log_length: 2, started: 1, stopped: 0}]}))
      .toEqual({ok: true, added: 2, reset: true});
    // A restarted tail repeats lines.
    expect(applyLog(s, {task_id: 5, offset: 0, lines: [line('a'), line('b'), line('c')]})).toEqual({ok: true, added: 1, reset: false});
    expect(applyLog(s, {task_id: 5, offset: 5, lines: [line('f')]})).toEqual({ok: false, from: 3});
    expect(s.lines.map((l) => l.c)).toEqual(['a', 'b', 'c']);
    // An older task's late message is ignored; done only with every line.
    expect(applyLog(s, {task_id: 4, offset: 3, lines: [line('x')]})).toEqual({ok: true, added: 0, reset: false});
    applyLog(s, {task_id: 5, offset: 3, lines: [line('d')], done: true});
    expect(s.done).toBe(true);
    expect(s.steps).toHaveLength(1);
    // A re-run.
    expect(applyLog(s, {task_id: 6, offset: 0, lines: [line('r')]})).toEqual({ok: true, added: 1, reset: true});
    expect([s.lines.length, s.done, s.steps.length]).toEqual([1, false, 0]);
  });

  test('property: any delivery order with repeats converges to the task\'s lines', () => {
    fc.assert(fc.property(fc.array(fc.nat(9), {minLength: 1, maxLength: 30}), (starts) => {
      const all = Array.from({length: 12}, (_, i) => line(String(i)));
      const s = emptyLog();
      for (const at of starts) {
        // Each message: lines from `at` to the end; a gap asks for `from`, which is delivered next.
        const r = applyLog(s, {task_id: 1, offset: at, lines: all.slice(at)});
        if (!r.ok) applyLog(s, {task_id: 1, offset: r.from, lines: all.slice(r.from)});
      }
      expect(s.lines.map((l) => l.c)).toEqual(all.map((l) => l.c));
    }));
  });

  test('stepOf', () => {
    const steps = [{name: 'a', status: 'success', log_index: 0, log_length: 2, started: 0, stopped: 0}, {name: 'b', status: 'running', log_index: 2, log_length: 3, started: 0, stopped: 0}];
    expect([0, 1, 2, 4, 5].map((l) => stepOf(steps, l))).toEqual([0, 0, 1, 1, -1]);
  });
});

describe('refs', () => {
  const refs: RefTable = {branches: new Map([['main', A], ['feature/x', B], ['feature', A]]), tags: new Map([['v1.0', B]]), defaultBranch: 'main'};

  test('code paths', () => {
    expect(parseCodePath('')).toEqual({view: 'src', rest: []});
    expect(parseCodePath('src/branch/feature/x/dir/f.go')).toEqual({view: 'src', kind: 'branch', rest: ['feature', 'x', 'dir', 'f.go']});
    expect(parseCodePath(`commit/${A}`)).toEqual({view: 'commit', sha: A});
    expect(parseCodePath('commit/abc123')).toBeUndefined();
    expect(parseCodePath('compare/main...feature/x')).toEqual({view: 'compare', base: 'main', head: 'feature/x'});
    expect(parseCodePath('compare/main')).toBeUndefined();
    expect(parseCodePath('actions/runs/3/jobs/1')).toEqual({view: 'run', run: 3, job: 1});
    expect(parseCodePath('actions/runs/3')).toEqual({view: 'run', run: 3, job: 0});
    expect(parseCodePath('branches/x')).toBeUndefined();
    expect(parseCodePath('nope')).toBeUndefined();
    // The END segment: dropped once (a path whose last name is "-" keeps it).
    expect(parseCodePath(withEnd('src/branch/main/a.txt'))).toEqual({view: 'src', kind: 'branch', rest: ['main', 'a.txt']});
    expect(parseCodePath(withEnd('src/branch/main/-'))).toEqual({view: 'src', kind: 'branch', rest: ['main', '-']});
    expect(withEnd('src/')).toBe('src/-');
  });

  test('the longest branch name wins; the default branch; full SHAs only', () => {
    expect(resolveRef(refs, 'branch', ['feature', 'x', 'a.go'])).toEqual({kind: 'branch', ref: 'feature/x', sha: B, path: 'a.go'});
    expect(resolveRef(refs, 'branch', ['feature', 'y'])).toEqual({kind: 'branch', ref: 'feature', sha: A, path: 'y'});
    expect(resolveRef(refs, undefined, ['docs'])).toEqual({kind: 'branch', ref: 'main', sha: A, path: 'docs'});
    expect(resolveRef(refs, 'tag', ['v1.0'])).toEqual({kind: 'tag', ref: 'v1.0', sha: B, path: ''});
    expect(resolveRef(refs, 'commit', [A, 'x', 'y'])).toEqual({kind: 'commit', ref: A, sha: A, path: 'x/y'});
    expect(resolveRef(refs, 'commit', ['abc'])).toBeUndefined();
    expect(resolveRef(refs, 'branch', ['gone'])).toBeUndefined();
    expect(resolveName(refs, 'v1.0')).toBe(B);
    expect(isSha(A.toUpperCase())).toBe(false);
    expect(codeSplat('src', {kind: 'branch', ref: 'feature/x'}, 'a b/c')).toBe('src/branch/feature/x/a b/c');
    // A path round-trips through parse + resolve.
    const r = parseCodePath(codeSplat('blame', {kind: 'branch', ref: 'feature/x'}, 'a b/c'));
    expect(r?.view === 'blame' ? resolveRef(refs, r.kind, r.rest) : undefined).toEqual({kind: 'branch', ref: 'feature/x', sha: B, path: 'a b/c'});
  });
});

test('languages by file name', () => {
  expect(langOf('src/a.tsx')).toBe('tsx');
  expect(langOf('Dockerfile')).toBe('docker');
  expect(langOf('x/Makefile')).toBe('make');
  expect(langOf('README')).toBeUndefined();
  expect(langOf('a.unknownext')).toBeUndefined();
  expect(langOf('.github/workflows/ci.YML')).toBe('yaml');
});

describe('viewed files', async () => {
  const {newestState, viewedAt} = await import('./viewed.ts');
  const st = (id: number, user: number, commit: string, at: string, files: Record<string, number>) => ({id, user_id: user, pull_id: 1, commit_sha: commit, updated_files: files, updated_at: at});
  test('the newest state of the viewer counts', () => {
    const s = [st(1, 5, A, '2026-01-01', {a: 2}), st(2, 5, B, '2026-02-01', {b: 2}), st(3, 6, B, '2026-03-01', {c: 2})];
    expect(newestState(s, 5)?.id).toBe(2);
    expect(newestState(s, 7)).toBeUndefined();
  });
  test('same head; older head with and without the has-changed answer; pending intents on top', () => {
    const s = st(1, 5, A, 'x', {a: 2, b: 2, c: 0, d: 1});
    expect([...viewedAt(s, A, undefined).paths].sort()).toEqual(['a', 'b']);
    const unknown = viewedAt(s, B, undefined);
    expect([...unknown.paths].sort()).toEqual(['a', 'b']);
    expect([...unknown.older].sort()).toEqual(['a', 'b']);
    const known = viewedAt(s, B, new Set(['a']));
    expect([...known.paths]).toEqual(['b']);
    expect(known.older.size).toBe(0);
    const o = viewedAt(s, A, undefined, new Map<unknown, boolean>([['a', false], ['z', true]]));
    expect([...o.paths].sort()).toEqual(['b', 'z']);
    expect(viewedAt(undefined, A, undefined).paths.size).toBe(0);
  });

  test('marks at a new head: changed files reset once, never over a pending mark', async () => {
    const {viewedMarks} = await import('./viewed.ts');
    const changed = new Set(['a', 'b']);
    expect(viewedMarks({commit: A, changed}, A, 'a', true)).toEqual({a: true});
    // First mark at B: the changed files go as not viewed, the marked one as viewed.
    expect(viewedMarks({commit: A, changed}, B, 'a', true)).toEqual({a: true, b: false});
    // A second mark before the server's state for B is back: 'a' has a pending mark, it is not reset.
    expect(viewedMarks({commit: A, changed}, B, 'b', true, new Map([['a', true], ['b', false]]))).toEqual({b: true});
  });
});

describe('compare merge base', async () => {
  const {baseCandidates, mergeBase} = await import('../features/code/Compare.tsx');
  const c = (sha: string, parents: string[]) => ({sha, message: sha, authorName: '', authorEmail: '', authorLogin: '', date: '2026-01-01', parents});
  test('a branch forked once: the oldest commit\'s parent', async () => {
    const info = {commits: [c('h2', ['h1']), c('h1', ['m0'])], total: 2};
    expect(baseCandidates(info, 'base')).toEqual(['m0']);
    expect(await mergeBase({} as never, 1, 'base', info)).toBe('m0');
  });
  test('base merged into head after forking: the newest shared commit, not the fork point', async () => {
    // x forked from m0; then base (m1, a child of m0) was merged into head as h.
    const info = {commits: [c('h', ['x', 'm1']), c('x', ['m0'])], total: 2};
    expect(baseCandidates(info, 'base')).toEqual(['m1', 'm0']);
    const src = {compare: (_r: number, a: string, b: string) => Promise.resolve({commits: a === 'm0' && b === 'm1' ? [c('m1', ['m0'])] : [], total: 0})};
    expect(await mergeBase(src as never, 1, 'base', info)).toBe('m1');
  });
});

test('sizeOf counts ArrayBuffers (images) by their bytes', async () => {
  const {sizeOf} = await import('./cache.ts');
  expect(sizeOf({kind: 'image', bytes: new ArrayBuffer(3_000_000), type: 'image/png', size: 3_000_000})).toBeGreaterThan(3_000_000);
});

test('ANSI charset designations (tput sgr0) are dropped', () => {
  expect(parseAnsi('\x1b(B\x1b[mok')).toEqual([{text: 'ok', color: 0, bold: false}]);
});

test('pr.viewed is "already done" only by the state saved for its own head', async () => {
  const {Pool} = await import('../data/pool.ts');
  const {effectHeld} = await import('../intents/effects.ts');
  const pool = new Pool();
  pool.batch(() => {
    pool.put('PullRequest', 5, 'repo:1', 1, {id: 5, issue_id: 7} as never);
    pool.put('ReviewState', 1, 'user:3', 2, {id: 1, user_id: 3, pull_id: 5, commit_sha: A, updated_files: {x: 2}, updated_at: '1'});
  });
  const i = (sha: string) => ({id: 'i', key: 'k', created: 0, issueId: 7, repoId: 1, kind: 'pr.viewed' as const, commitSha: sha, files: {x: true}});
  expect(effectHeld(pool, i(A), 3)).toBe(true);
  // Viewed at A, changed at B: marking it viewed at B must be sent.
  expect(effectHeld(pool, i(B), 3)).toBe(false);
});

test('code paths with "." or ".." segments are refused (they would resolve away in request URLs)', async () => {
  const {encodePath} = await import('./source.ts');
  expect(parseCodePath('src/branch/main/x%2F..%2F..%2F1'.replace(/%2F/g, '/'))).toBeUndefined();
  expect(parseCodePath('src/branch/main/./a')).toBeUndefined();
  expect(() => encodePath('a/../b')).toThrow();
  expect(encodePath('a b/c#d')).toBe('a%20b/c%23d');
});
