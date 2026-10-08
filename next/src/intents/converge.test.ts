// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Phase 3 exit property (PLAN §8, §9): any interleaving of offline
// intents in several tabs, other users' changes, lost answers and 503s,
// connection changes, leader changes and tab crashes converges — every tab
// shows the server's state, the queue empties — with no loss (every
// comment posted once, every line typed into a body is in the final text,
// every change nobody else touched is on the server) and no duplicates
// (no idempotency key runs twice, none is reused for another request).

import fc from 'fast-check';
import {untracked} from 'mobx';
import {describe, expect, test} from 'vitest';
import {FakeForgejo, REPO, type RemoteOp} from '../test/fakeForgejo.ts';
import {type Tab, World} from '../test/fakeTabs.ts';
import {MARK_MINE, MARK_SPLIT, MARK_THEIRS} from './merge3.ts';
import {issueBody, issueLabelIds, issueState, issueTitle} from './view.ts';

/** CONVERGE_RUNS=5000 for a long run (CI: 60). */
const RUNS = Number(process.env.CONVERGE_RUNS ?? 60);
const ISSUES = 3;
const LABELS = 4;

type LocalOp =
  | {t: 'state'; issue: number}
  | {t: 'title'; issue: number}
  | {t: 'label'; issue: number; label: number}
  | {t: 'body'; issue: number; at: number}
  | {t: 'comment'; issue: number}
  | {t: 'commentEdit'; issue: number};

type Step =
  | {t: 'local'; tab: number; op: LocalOp}
  | {t: 'remote'; op: RemoteOp}
  | {t: 'offline'} | {t: 'online'}
  | {t: 'deliver'; tab: number}
  | {t: 'run'}
  | {t: 'lose'; n: number} | {t: 'fail'}
  | {t: 'crash'} | {t: 'spawn'};

const issueArb = fc.integer({min: 1, max: ISSUES});
const localArb: fc.Arbitrary<LocalOp> = fc.oneof(
  fc.record({t: fc.constant('state' as const), issue: issueArb}),
  fc.record({t: fc.constant('title' as const), issue: issueArb}),
  fc.record({t: fc.constant('label' as const), issue: issueArb, label: fc.integer({min: 1, max: LABELS})}),
  fc.record({t: fc.constant('body' as const), issue: issueArb, at: fc.nat(6)}),
  fc.record({t: fc.constant('comment' as const), issue: issueArb}),
  fc.record({t: fc.constant('commentEdit' as const), issue: issueArb}),
);
const remoteArb: fc.Arbitrary<RemoteOp> = fc.oneof(
  fc.record({t: fc.constant('state' as const), issue: issueArb}),
  fc.record({t: fc.constant('title' as const), issue: issueArb, title: fc.constant('')}),
  fc.record({t: fc.constant('label' as const), issue: issueArb, label: fc.integer({min: 1, max: LABELS}), add: fc.boolean()}),
  fc.record({t: fc.constant('body' as const), issue: issueArb, at: fc.nat(6), token: fc.constant('')}),
  fc.record({t: fc.constant('comment' as const), issue: issueArb, token: fc.constant('')}),
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {weight: 6, arbitrary: fc.record({t: fc.constant('local' as const), tab: fc.nat(2), op: localArb})},
  {weight: 3, arbitrary: fc.record({t: fc.constant('remote' as const), op: remoteArb})},
  {weight: 1, arbitrary: fc.constant({t: 'offline' as const})},
  {weight: 1, arbitrary: fc.constant({t: 'online' as const})},
  {weight: 2, arbitrary: fc.record({t: fc.constant('deliver' as const), tab: fc.nat(2)})},
  {weight: 3, arbitrary: fc.constant({t: 'run' as const})},
  {weight: 2, arbitrary: fc.record({t: fc.constant('lose' as const), n: fc.integer({min: 1, max: 4})})},
  {weight: 1, arbitrary: fc.constant({t: 'fail' as const})},
  {weight: 1, arbitrary: fc.constant({t: 'crash' as const})},
  {weight: 1, arbitrary: fc.constant({t: 'spawn' as const})},
);

/** What the test expects to find on the server in the end. */
interface Expect {
  comments: Set<string>;
  bodyTokens: Map<number, Set<string>>;
  /** Fields only this user changed: field key → the last value submitted. */
  last: Map<string, unknown>;
  /** Fields another user changed too (no last-writer expectation). */
  remoteTouched: Set<string>;
}

let tokens = 0;
const token = (p: string) => `${p}${String(++tokens)}`;

function local(tab: Tab, op: LocalOp, ex: Expect): void {
  const {pool, overlay, intents} = tab;
  const issue = untracked(() => pool.model('Issue').get(op.issue));
  if (!issue) return;
  const ref = {issueId: op.issue, repoId: REPO};
  untracked(() => {
    switch (op.t) {
      case 'state': {
        const cur = issueState(overlay, issue);
        const state = cur === 'open' ? 'closed' as const : 'open' as const;
        intents.submit({...ref, kind: 'issue.state', state, base: cur});
        ex.last.set(`state:${String(op.issue)}`, state);
        break;
      }
      case 'title': {
        const title = token('T');
        intents.submit({...ref, kind: 'issue.title', title, base: issueTitle(overlay, issue)});
        ex.last.set(`title:${String(op.issue)}`, title);
        break;
      }
      case 'label': {
        const has = issueLabelIds(pool, overlay, op.issue).includes(op.label);
        intents.submit({...ref, kind: 'issue.label', labelId: op.label, add: !has, drop: []});
        ex.last.set(`label:${String(op.issue)}:${String(op.label)}`, !has);
        break;
      }
      case 'body': {
        const b = issueBody(pool, overlay, op.issue);
        if (!b) return;
        const lines = b.text.split('\n');
        const t = token('L');
        lines.splice(op.at % (lines.length + 1), 0, t);
        const version = b.local ? -1 : pool.model('IssueBody').get(op.issue)?.data.content_version ?? -1;
        intents.submit({...ref, kind: 'issue.body', text: lines.join('\n'), baseText: b.text, baseVersion: version});
        ex.bodyTokens.get(op.issue)?.add(t);
        break;
      }
      case 'comment': {
        const body = token('C');
        intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body});
        ex.comments.add(body);
        break;
      }
      case 'commentEdit': {
        const c = [...pool.model('Comment').by('issue_id', op.issue)][0];
        if (!c || overlay.field('Comment', c.id, 'body')) return;
        intents.submit({...ref, kind: 'comment.edit', commentId: c.id, text: `${c.data.body} ${token('E')}`, baseText: c.data.body, baseVersion: c.data.content_version, baseUpdated: c.data.updated_at});
        break;
      }
    }
  });
}

/** Resolves every parked conflict the way a user keeping both sides would. */
function resolveAll(world: World): void {
  const l = world.leader;
  if (!l) return;
  for (const r of [...l.intents.records.values()]) {
    if (r.state !== 'parked' || !r.conflict) continue;
    // Each conflicting region: my lines, then theirs that I do not have.
    const out: string[] = [];
    let mine: string[] | undefined;
    let theirs: string[] | undefined;
    for (const x of r.conflict.merged.split('\n')) {
      if (x === MARK_MINE) mine = [];
      else if (x === MARK_SPLIT) theirs = [];
      else if (x === MARK_THEIRS) {
        out.push(...mine ?? [], ...(theirs ?? []).filter((t) => !mine?.includes(t)));
        mine = undefined;
        theirs = undefined;
      } else (theirs ?? mine ?? out).push(x);
    }
    const text = out.join('\n');
    l.intents.resolve(r.id, text);
  }
}

async function scenario(steps: Step[], lag = 1): Promise<void> {
  const server = new FakeForgejo(ISSUES, LABELS);
  const world = new World(server, 2);
  // Deltas late by a few rounds: echoes arrive after the next intents of an entity would be prepared.
  world.lag = lag;
  const ex: Expect = {comments: new Set(), bodyTokens: new Map(), last: new Map(), remoteTouched: new Set()};
  for (let n = 1; n <= ISSUES; n++) ex.bodyTokens.set(n, new Set());
  await world.settle(5);
  try {
    for (const s of steps) {
      switch (s.t) {
        case 'local': {
          const tabs = world.alive();
          const tab = tabs[s.tab % tabs.length];
          if (tab) local(tab, s.op, ex);
          break;
        }
        case 'remote': {
          let op = s.op;
          if (op.t === 'body') {
            op = {...op, token: token('R')};
            ex.bodyTokens.get(op.issue)?.add(op.token);
          }
          if (op.t === 'comment') op = {...op, token: token('X')};
          if (op.t === 'title') op = {...op, title: token('RT')};
          if (op.t === 'state') ex.remoteTouched.add(`state:${String(op.issue)}`);
          if (op.t === 'title') ex.remoteTouched.add(`title:${String(op.issue)}`);
          if (op.t === 'label') ex.remoteTouched.add(`label:${String(op.issue)}:${String(op.label)}`);
          server.remote(op);
          break;
        }
        case 'offline':
          server.online = false;
          for (const t of world.alive()) t.setConnection('offline');
          break;
        case 'online':
          server.online = true;
          for (const t of world.alive()) t.setConnection('live');
          break;
        case 'deliver':
          world.alive()[s.tab % world.alive().length]?.deliver();
          break;
        case 'run':
          await world.settle(6);
          break;
        case 'lose':
          server.lose += s.n;
          break;
        case 'fail':
          server.fail++;
          break;
        case 'crash':
          world.crash();
          break;
        case 'spawn':
          if (world.alive().length < 3) {
            const t = world.spawn();
            if (!server.online) t.setConnection('offline');
          }
          break;
      }
      await Promise.resolve();
    }
    // Back online for good; conflicts resolved by the user; everything settles.
    // Faults still pending hit the flush.
    server.online = true;
    for (const t of world.alive()) t.setConnection('live');
    for (let round = 0; round < 4; round++) {
      await world.settle();
      resolveAll(world);
    }
    await world.settle();

    // No duplicates: no key ran twice, none was reused for another request.
    expect(server.mismatches).toEqual([]);
    for (const [key, n] of server.runs) expect(n, key).toBe(1);
    // The queue is empty and nothing failed (nothing here is refused), in every tab and in IndexedDB.
    const leader = world.leader;
    expect(leader).toBeDefined();
    const stored = await new (await import('./store.ts')).IntentDb(world.db).list();
    expect(stored.map((r) => `${r.intent.kind}:${r.state}:${r.note ?? ''}:${String(r.attempts)}:${r.req ? "req" : ""}`)).toEqual([]);
    for (const t of world.alive()) {
      expect([...t.intents.records.values()].map((r) => r.intent.kind), `tab ${String(t.n)}`).toEqual([]);
      expect(t.overlay.size, `tab ${String(t.n)} overlay`).toBe(0);
      expect([...t.intents.drafts.values()].map((d) => d.reason)).toEqual([]);
    }
    // No loss: every comment once; every line typed (here or by others) in the body.
    const bodies = [...server.comments.values()].map((c) => c.body.split(' ')[0]);
    for (const c of ex.comments) expect(bodies.filter((b) => b === c), c).toHaveLength(1);
    for (const [n, toks] of ex.bodyTokens) {
      const lines = server.issues.get(n)?.body.split('\n') ?? [];
      for (const tk of toks) expect(lines.filter((l) => l === tk), `${tk} in #${String(n)}: ${lines.join('|')}`).toHaveLength(1);
    }
    // What only this user changed ends as this user last set it.
    for (const [k, v] of ex.last) {
      if (ex.remoteTouched.has(k)) continue;
      const [field, n, label] = k.split(':');
      const s = server.issues.get(Number(n));
      const got = field === 'state' ? s?.state : field === 'title' ? s?.title : s?.labels.has(Number(label));
      expect(got, k).toBe(v);
    }
    // Every tab shows the server's state.
    for (const t of world.alive()) {
      for (const [n, s] of server.issues) {
        const e = untracked(() => t.pool.model('Issue').get(n));
        expect(e, `tab ${String(t.n)} #${String(n)}`).toBeDefined();
        if (!e) continue;
        untracked(() => {
          expect(issueState(t.overlay, e)).toBe(s.state);
          expect(issueTitle(t.overlay, e)).toBe(s.title);
          expect(issueLabelIds(t.pool, t.overlay, n).sort()).toEqual([...s.labels].sort());
          expect(issueBody(t.pool, t.overlay, n)?.text).toBe(s.body);
        });
      }
      const comments = untracked(() => [...t.pool.model('Comment').all()].map((c) => `${String(c.id)}:${c.data.body}`).sort());
      expect(comments).toEqual([...server.comments.values()].filter((c) => !c.deleted).map((c) => `${String(c.id)}:${c.body}`).sort());
    }
  } finally {
    world.close();
  }
}

describe('convergence (PLAN §8 Phase 3 exit)', () => {
  test('regression: two tabs change one title, a tab opens, the leader dies before announcing its intent', async () => {
    for (let k = 0; k < 20; k++) {
      await scenario([
        {t: 'online'},
        {t: 'local', tab: 2, op: {t: 'title', issue: 2}},
        {t: 'local', tab: 1, op: {t: 'title', issue: 2}},
        {t: 'local', tab: 1, op: {t: 'comment', issue: 2}},
        {t: 'spawn'},
        {t: 'crash'},
        {t: 'run'},
        {t: 'deliver', tab: 0},
      ]);
    }
  }, 60_000);


  test('a create whose answer is lost, then the leader dies: retried under its key, one comment', async () => {
    await scenario([
      {t: 'offline'},
      {t: 'local', tab: 1, op: {t: 'comment', issue: 2}},
      {t: 'local', tab: 0, op: {t: 'comment', issue: 3}},
      {t: 'lose', n: 2},
      {t: 'online'},
      {t: 'run'},
      {t: 'crash'},
      {t: 'lose', n: 1},
      {t: 'run'},
    ]);
  }, 30_000);

  test('any interleaving of offline intents, remote changes, faults, leader changes and crashes converges without loss or duplicates', async () => {
    await fc.assert(fc.asyncProperty(fc.array(stepArb, {minLength: 1, maxLength: 30}), fc.constantFrom(1, 1, 3, 7), scenario), {numRuns: RUNS, endOnFailure: true, timeout: 20_000});
  }, Math.max(300_000, RUNS * 1000));

  test('a scripted worst case: offline edits in two tabs, others edit the same issue, the leader dies mid-flush with a lost answer', async () => {
    await scenario([
      {t: 'offline'},
      {t: 'local', tab: 0, op: {t: 'label', issue: 1, label: 2}},
      {t: 'local', tab: 1, op: {t: 'body', issue: 1, at: 1}},
      {t: 'local', tab: 0, op: {t: 'comment', issue: 1}},
      {t: 'local', tab: 1, op: {t: 'body', issue: 1, at: 3}},
      {t: 'remote', op: {t: 'body', issue: 1, at: 1, token: ''}},
      {t: 'remote', op: {t: 'label', issue: 1, label: 3, add: true}},
      {t: 'lose', n: 1},
      {t: 'online'},
      {t: 'run'},
      {t: 'crash'},
      {t: 'run'},
      {t: 'local', tab: 0, op: {t: 'comment', issue: 1}},
    ]);
  }, 30_000);
});


