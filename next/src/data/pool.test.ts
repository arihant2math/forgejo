// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import {autorun, configure} from 'mobx';
import {describe, expect, test} from 'vitest';
import type {Issue} from '../protocol/types.gen.ts';
import {replaceGroup} from '../sync/replace.ts';
import {Pool} from './pool.ts';

configure({enforceActions: 'never'});

function issue(id: number, repo: number, title: string, extra: Partial<Issue> = {}): Issue {
  return {
    id, repo_id: repo, number: id, poster_id: 1, original_author: '', original_author_id: 0, title, content_version: 0,
    milestone_id: 0, priority: 0, state: 'open', is_pull: false, comments: 0, ref: '', pin_order: 0, is_locked: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
  };
}

describe('write primitives', () => {
  test('put keeps only newer versions', () => {
    const p = new Pool();
    expect(p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'))).toBe(true);
    expect(p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'b'))).toBe(false);
    expect(p.put('Issue', 1, 'repo:1', 4, issue(1, 1, 'c'))).toBe(false);
    expect(p.model('Issue').get(1)?.get('title')).toBe('a');
    expect(p.put('Issue', 1, 'repo:1', 6, issue(1, 1, 'd'))).toBe(true);
    expect(p.model('Issue').get(1)?.get('title')).toBe('d');
  });

  test('a delete leaves a group-scoped tombstone', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'));
    expect(p.del('Issue', 1, 'repo:1', 7)).toBe(true);
    expect(p.model('Issue').get(1)).toBeUndefined();
    // An older state in that group (an overlapping bootstrap) cannot bring it back.
    expect(p.put('Issue', 1, 'repo:1', 6, issue(1, 1, 'stale'))).toBe(false);
    // A newer state, or a state in another group, can.
    expect(p.put('Issue', 1, 'repo:2', 6, issue(1, 2, 'moved'))).toBe(true);
    expect(p.model('Issue').get(1)?.group).toBe('repo:2');
  });

  test('a delete older than the held state is ignored', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:2', 9, issue(1, 2, 'moved'));
    expect(p.del('Issue', 1, 'repo:1', 8)).toBe(false);
    expect(p.model('Issue').get(1)?.get('title')).toBe('moved');
  });

  test('evict only drops what is held in that group at or below maxV', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'));
    p.put('Issue', 2, 'repo:1', 9, issue(2, 1, 'b'));
    p.put('Issue', 3, 'repo:2', 3, issue(3, 2, 'c'));
    expect(p.evict('Issue', 1, 'repo:1', 8)).toBe(true);
    expect(p.evict('Issue', 2, 'repo:1', 8)).toBe(false);
    expect(p.evict('Issue', 3, 'repo:1', 8)).toBe(false);
    expect(p.put('Issue', 1, 'repo:1', 8, issue(1, 1, 'stale'))).toBe(false);
    expect([...p.groupEntities('repo:1')].map((e) => e.id)).toEqual([2]);
  });

  test('purgeGroup drops the group and blocks its older states', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'));
    p.put('Issue', 2, 'repo:2', 6, issue(2, 2, 'b'));
    expect(p.purgeGroup('repo:1')).toBe(1);
    expect(p.model('Issue').size).toBe(1);
    expect(p.put('Issue', 3, 'repo:1', 6, issue(3, 1, 'in flight'))).toBe(false);
    expect(p.put('Issue', 3, 'repo:1', 7, issue(3, 1, 'after a re-grant'))).toBe(true);
  });

  test('dirty tracking', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'));
    p.put('Label', 2, 'repo:1', 5, {id: 2, repo_id: 1, org_id: 0, name: 'x', exclusive: false, description: '', color: '', num_issues: 0, num_closed_issues: 0, created_at: '', updated_at: ''});
    p.del('Issue', 1, 'repo:1', 6);
    const d = p.takeDirty();
    expect([...d.get('Issue')?.keys() ?? []]).toEqual([1]);
    expect([...d.get('Label')?.keys() ?? []]).toEqual([2]);
    expect(p.dirtyCount).toBe(0);
    p.load('Issue', [{id: 7, g: 'repo:1', v: 3, d: issue(7, 1, 'loaded')}]);
    expect(p.dirtyCount).toBe(0);
  });
});

describe('reactivity', () => {
  test('a field observer reacts to that field only, and its atom goes away', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 1, issue(1, 1, 'a'));
    const e = p.model('Issue').get(1);
    if (!e) throw new Error('missing');
    const seen: string[] = [];
    const stop = autorun(() => {
      seen.push(e.get('title'));
    });
    p.batch(() => p.put('Issue', 1, 'repo:1', 2, issue(1, 1, 'a', {state: 'closed'})));
    expect(seen).toEqual(['a']);
    p.batch(() => p.put('Issue', 1, 'repo:1', 3, issue(1, 1, 'b', {state: 'closed'})));
    expect(seen).toEqual(['a', 'b']);
    expect(e._atoms?.size).toBe(1);
    stop();
    expect(e._atoms?.size).toBe(0);
  });

  test('no atoms are created outside reactions', () => {
    const p = new Pool();
    p.put('Issue', 1, 'repo:1', 1, issue(1, 1, 'a'));
    const e = p.model('Issue').get(1);
    expect(e?.get('title')).toBe('a');
    expect(e?.data.title).toBe('a');
    expect(e?._atoms?.size ?? 0).toBe(0);
  });

  test('get reacts to arrival and removal; by reacts to membership', () => {
    const p = new Pool();
    const issues = p.model('Issue');
    const got: (string | undefined)[] = [];
    const sizes: number[] = [];
    const s1 = autorun(() => {
      got.push(issues.get(5)?.get('title'));
    });
    const s2 = autorun(() => {
      sizes.push(issues.by('repo_id', 1).size);
    });
    p.batch(() => {
      p.put('Issue', 5, 'repo:1', 1, issue(5, 1, 'five'));
      p.put('Issue', 6, 'repo:1', 1, issue(6, 1, 'six'));
    });
    expect(got).toEqual([undefined, 'five']);
    expect(sizes).toEqual([0, 2]);
    // Moving issue 6 to another repository changes the bucket, not issue 5's observer.
    p.batch(() => p.put('Issue', 6, 'repo:2', 2, issue(6, 2, 'six')));
    expect(sizes).toEqual([0, 2, 1]);
    expect(got).toEqual([undefined, 'five']);
    p.batch(() => p.del('Issue', 5, 'repo:1', 3));
    expect(got).toEqual([undefined, 'five', undefined]);
    expect(sizes).toEqual([0, 2, 1, 0]);
    s1();
    s2();
  });

  test('a batch notifies once', () => {
    const p = new Pool();
    let runs = 0;
    const stop = autorun(() => {
      expect(p.model('Issue').size).toBeGreaterThanOrEqual(0);
      runs++;
    });
    p.batch(() => {
      for (let i = 1; i <= 100; i++) p.put('Issue', i, 'repo:1', i, issue(i, 1, String(i)));
    });
    expect(runs).toBe(2);
    stop();
  });

  test('onApplied reports removals after the batch', () => {
    const p = new Pool();
    const removed: number[] = [];
    p.onApplied((changes) => {
      for (const c of changes) if (!c.entity) removed.push(c.id);
    });
    p.batch(() => {
      p.put('Issue', 1, 'repo:1', 1, issue(1, 1, 'a'));
      p.del('Issue', 1, 'repo:1', 2);
      expect(removed).toEqual([]);
    });
    expect(removed).toEqual([1]);
  });
});

describe('follower mirror', () => {
  test('states from older flushes are ignored, whatever the order', () => {
    const p = new Pool();
    p.mirror('Issue', 1, {id: 1, g: 'repo:1', v: 9, d: issue(1, 1, 'new')}, 5);
    p.mirror('Issue', 1, {id: 1, g: 'repo:1', v: 3, d: issue(1, 1, 'old read')}, 4);
    expect(p.model('Issue').get(1)?.get('title')).toBe('new');
    p.mirror('Issue', 1, null, 6);
    p.mirror('Issue', 1, {id: 1, g: 'repo:1', v: 9, d: issue(1, 1, 'late read')}, 5);
    expect(p.model('Issue').get(1)).toBeUndefined();
  });

  test('retainSeen drops what a complete read did not see', () => {
    const p = new Pool();
    p.mirror('Issue', 1, {id: 1, g: 'repo:1', v: 1, d: issue(1, 1, 'a')}, 1);
    p.mirror('Issue', 2, {id: 2, g: 'repo:1', v: 1, d: issue(2, 1, 'b')}, 1);
    p.mirror('Issue', 3, {id: 3, g: 'repo:1', v: 1, d: issue(3, 1, 'c')}, 9);
    p.retainSeen(new Map([['Issue', new Set([1])]]), 5);
    expect([...p.model('Issue').all()].map((e) => e.id).sort()).toEqual([1, 3]);
  });

  test('a cleared model ignores older reads', () => {
    const p = new Pool();
    p.mirror('Issue', 1, {id: 1, g: 'repo:1', v: 1, d: issue(1, 1, 'a')}, 1);
    p.clearModel('Issue', 4);
    p.mirror('Issue', 2, {id: 2, g: 'repo:1', v: 1, d: issue(2, 1, 'b')}, 3);
    expect(p.model('Issue').size).toBe(0);
  });
});

// ---- convergence (PLAN §9: fuzzing the delta applier for idempotency and ordering) ----

interface Entry {v: number; g: string; id: number; op: 'U' | 'D'; title?: string}
type Ev =
  | {k: 'entry'; e: Entry}
  | {k: 'lines'; b: number; lines: Entry[]}
  | {k: 'end'; b: number};

const GROUPS = ['repo:1', 'repo:2', 'repo:3'];

/** A server history: creates, updates, moves (D in the old group + U in the new one) and deletes. */
const historyArb = fc.array(fc.record({
  id: fc.integer({min: 1, max: 6}),
  kind: fc.constantFrom('upsert', 'move', 'delete'),
  g: fc.constantFrom(...GROUPS),
}), {minLength: 1, maxLength: 40});

interface Server {
  log: Entry[];
  /** The state at each sync id: id → {g, title}. */
  at: Map<number, {g: string; title: string}>[];
}

function simulate(ops: {id: number; kind: string; g: string}[]): Server {
  const log: Entry[] = [];
  const cur = new Map<number, {g: string; title: string}>();
  const at = [new Map(cur)];
  const push = (e: Omit<Entry, 'v'>) => {
    log.push({...e, v: log.length + 1});
    if (e.op === 'U') cur.set(e.id, {g: e.g, title: e.title ?? ''});
    else cur.delete(e.id);
    at.push(new Map(cur));
  };
  for (const op of ops) {
    const held = cur.get(op.id);
    if (op.kind === 'delete') {
      if (held) push({g: held.g, id: op.id, op: 'D'});
    } else if (op.kind === 'move' && held && held.g !== op.g) {
      push({g: held.g, id: op.id, op: 'D'});
      push({g: op.g, id: op.id, op: 'U', title: `${held.title}>`});
    } else {
      const g = held?.g ?? op.g;
      push({g, id: op.id, op: 'U', title: `t${log.length + 1}`});
    }
  }
  return {log, at};
}

function snapshot(s: Server, g: string, w: number): Entry[] {
  const out: Entry[] = [];
  for (const [id, st] of s.at[w] ?? []) if (st.g === g) out.push({v: w, g, id, op: 'U', title: st.title});
  return out;
}

function apply(p: Pool, ev: Ev, boots: Map<number, {g: string; w: number; ids: Set<number>}>): void {
  const put = (e: Entry) => {
    if (e.op === 'U') p.put('Issue', e.id, e.g, e.v, issue(e.id, 0, e.title ?? ''));
    else p.del('Issue', e.id, e.g, e.v);
  };
  if (ev.k === 'entry') {
    p.batch(() => {
      put(ev.e);
    });
  } else if (ev.k === 'lines') {
    p.batch(() => {
      ev.lines.forEach(put);
    });
  }
  else {
    const b = boots.get(ev.b);
    if (!b) return;
    replaceGroup(p, {
      group: b.g,
      header: {type: 'header', group: b.g, watermark: b.w, units: [], tier: 'full', schemas: {}},
      end: {type: 'end', count: b.ids.size, refs: []},
      received: new Map([['Issue', b.ids]]),
      heldUnits: [],
    });
  }
}

function state(p: Pool): Map<number, {g: string; title: string}> {
  const out = new Map<number, {g: string; title: string}>();
  for (const e of p.model('Issue').all()) out.set(e.id, {g: e._g, title: e._d.title});
  return out;
}

describe('convergence', () => {
  test('any interleaving and duplication of bootstraps and deltas converges to the server state', () => {
    fc.assert(fc.property(
      historyArb.chain((ops) => {
        const s = simulate(ops);
        const head = s.log.length;
        return fc.record({
          s: fc.constant(s),
          // Per group: the watermark of the bootstrap that covers it (0 = none: every entry is delivered).
          ws: fc.tuple(...GROUPS.map(() => fc.integer({min: 0, max: head}))),
          // Noise: extra entries (any, also older ones), extra (possibly incomplete) bootstraps.
          extra: fc.array(fc.integer({min: 1, max: Math.max(1, head)}), {maxLength: 30}),
          extraBoots: fc.array(fc.record({g: fc.constantFrom(...GROUPS), w: fc.integer({min: 0, max: head}), complete: fc.boolean()}), {maxLength: 4}),
          order: fc.array(fc.double({min: 0, max: 1, noNaN: true}), {minLength: 200, maxLength: 200}),
          split: fc.array(fc.integer({min: 0, max: 5}), {minLength: 10, maxLength: 10}),
        });
      }),
      ({s, ws, extra, extraBoots, order, split}) => {
        const events: {ev: Ev; key: number}[] = [];
        const boots = new Map<number, {g: string; w: number; ids: Set<number>}>();
        let key = 0;
        const nextKey = () => order[key++ % order.length] ?? 0;
        const addBoot = (g: string, w: number, complete: boolean) => {
          const b = boots.size + 1;
          const lines = snapshot(s, g, w);
          boots.set(b, {g, w, ids: new Set(lines.map((l) => l.id))});
          // The lines arrive in up to two chunks, then the end line; other messages may come in between.
          const cut = Math.min(lines.length, split[b % split.length] ?? 0);
          const parts: Ev[] = [{k: 'lines', b, lines: lines.slice(0, cut)}, {k: 'lines', b, lines: lines.slice(cut)}];
          if (complete) parts.push({k: 'end', b});
          const keys = parts.map(nextKey).sort((a, b2) => a - b2);
          parts.forEach((ev, i) => events.push({ev, key: keys[i] ?? 0}));
        };
        GROUPS.forEach((g, i) => {
          const w = ws[i] ?? 0;
          if (w > 0) addBoot(g, w, true);
          for (const e of s.log) if (e.g === g && e.v > w) events.push({ev: {k: 'entry', e}, key: nextKey()});
        });
        for (const v of extra) {
          const e = s.log[v - 1];
          if (e) events.push({ev: {k: 'entry', e}, key: nextKey()});
        }
        for (const b of extraBoots) if (b.w > 0) addBoot(b.g, b.w, b.complete);
        events.sort((a, b) => a.key - b.key);
        const p = new Pool();
        for (const {ev} of events) apply(p, ev, boots);
        expect(state(p)).toEqual(s.at[s.log.length]);
      },
    ), {numRuns: 600});
  });

  test('applying everything twice changes nothing (idempotency)', () => {
    fc.assert(fc.property(historyArb, fc.integer({min: 0, max: 40}), (ops, wRaw) => {
      const s = simulate(ops);
      const w = Math.min(wRaw, s.log.length);
      const boots = new Map<number, {g: string; w: number; ids: Set<number>}>();
      const evs: Ev[] = [];
      for (const g of GROUPS) {
        const lines = snapshot(s, g, w);
        const b = boots.size + 1;
        boots.set(b, {g, w, ids: new Set(lines.map((l) => l.id))});
        evs.push({k: 'lines', b, lines}, {k: 'end', b});
      }
      for (const e of s.log) if (e.v > w) evs.push({k: 'entry', e});
      const p = new Pool();
      for (const ev of evs) apply(p, ev, boots);
      const once = state(p);
      for (const ev of evs) apply(p, ev, boots);
      expect(state(p)).toEqual(once);
      expect(once).toEqual(s.at[s.log.length]);
    }), {numRuns: 300});
  });

  test('a revoked group re-bootstrapped later converges, and nothing in flight resurrects it', () => {
    fc.assert(fc.property(historyArb, fc.integer({min: 0, max: 40}), fc.integer({min: 0, max: 40}), (ops, a, b) => {
      const s = simulate(ops);
      const head = s.log.length;
      const g = 'repo:1';
      const before = Math.min(a, head);
      const p = new Pool();
      const boots = new Map<number, {g: string; w: number; ids: Set<number>}>();
      const lines1 = snapshot(s, g, before);
      boots.set(1, {g, w: before, ids: new Set(lines1.map((l) => l.id))});
      apply(p, {k: 'lines', b: 1, lines: lines1}, boots);
      for (const e of s.log) if (e.g === g && e.v <= Math.min(b, head)) apply(p, {k: 'entry', e}, boots);
      p.purgeGroup(g);
      // In flight when the revocation arrived: they must not come back.
      apply(p, {k: 'lines', b: 1, lines: lines1}, boots);
      expect([...p.groupEntities(g)]).toEqual([]);
      // Re-granted: a fresh bootstrap (its watermark is past everything the client saw) and the rest.
      const fresh = head + 1;
      const lines2 = snapshot({...s, at: [...s.at, s.at[head] ?? new Map<number, {g: string; title: string}>()]}, g, fresh);
      boots.set(2, {g, w: fresh, ids: new Set(lines2.map((l) => l.id))});
      apply(p, {k: 'lines', b: 2, lines: lines2}, boots);
      apply(p, {k: 'end', b: 2}, boots);
      const want = new Map([...s.at[head] ?? []].filter(([, st]) => st.g === g));
      expect(new Map([...state(p)].filter(([, st]) => st.g === g))).toEqual(want);
    }), {numRuns: 300});
  });
});
