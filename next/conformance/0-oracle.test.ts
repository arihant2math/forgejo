// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The suite's own oracles, without the server: the per-delta invariants
// every session checks (sync.ts) and the strict reading of bootstrap NDJSON
// (replica.ts). A lenient oracle lets a server regression pass the suite.

import {describe, expect, test} from 'vitest';
import type {Change, DeltaMessage} from '../src/protocol/types.gen.ts';
import {parseLoaded} from './replica.ts';
import {deltaViolations} from './sync.ts';

const delta = (...changes: Change[]): DeltaMessage => ({type: 'delta', changes, to: Math.max(0, ...changes.map((c) => c.v))});
const user = (id: number, g: string, v: number): Change => ({g, m: 'User', id, op: 'U', v, d: {id, login: `u${id}`}});
const holds = (...groups: string[]) => (g: string) => groups.includes(g);

describe('deltaViolations', () => {
  test('the viewer\'s own profile may arrive outside the groups held', () => {
    expect(deltaViolations(delta(user(7, 'user:7', 5)), holds(), 7)).toEqual([]);
  });

  test('another user\'s profile outside the groups held is a leak', () => {
    expect(deltaViolations(delta(user(8, 'user:8', 5)), holds('repo:1'), 7)).toEqual([
      'change of user:8 (User 8 U), which the session does not hold',
    ]);
    // Before the welcome nobody's profile is exempt.
    expect(deltaViolations(delta(user(7, 'user:7', 5)), holds(), undefined)).toHaveLength(1);
  });

  test('a delete of the viewer is not a profile update', () => {
    expect(deltaViolations(delta({g: 'user:7', m: 'User', id: 7, op: 'D', v: 5}), holds(), 7)).toHaveLength(1);
  });

  test('pseudo groups, order and payloads', () => {
    const issue = (v: number, op: 'U' | 'D' = 'U'): Change => ({g: 'repo:1', m: 'Issue', id: v, op, v, d: {id: v}});
    expect(deltaViolations(delta(issue(1), issue(2)), holds('repo:1'), 7)).toEqual([]);
    expect(deltaViolations(delta(issue(2), issue(2)), holds('repo:1'), 7)).toEqual(['changes of repo:1 out of sync id order (2)']);
    expect(deltaViolations(delta({...issue(1), g: '!perm'}), holds('!perm'), 7)).toEqual(['change in pseudo group !perm']);
    expect(deltaViolations(delta({g: 'repo:1', m: 'Issue', id: 1, op: 'U', v: 1}), holds('repo:1'), 7)).toEqual(['upsert without payload (Issue 1)']);
    expect(deltaViolations(delta(issue(1, 'D')), holds('repo:1'), 7)).toEqual(['delete with payload (Issue 1)']);
  });
});

function body(...lines: unknown[]): ReadableStream<Uint8Array> {
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join('')).body as ReadableStream<Uint8Array>;
}

describe('parseLoaded', () => {
  const header = {type: 'header', group: 'repo:1', watermark: 9, tier: 'summary', units: ['issues']};
  const end = {type: 'end', count: 1};
  const issue = {g: 'repo:1', m: 'Issue', id: 1, op: 'U', v: 9, d: {id: 1}};

  test('header, entities, end', async () => {
    const got = await parseLoaded(body(header, issue, end), 'repo:1');
    expect(got.header.watermark).toBe(9);
    expect(got.changes).toHaveLength(1);
    expect(got.end.count).toBe(1);
  });

  test.each([
    ['a response cut before its end line', [header, issue], /incomplete/],
    ['no header', [issue, end], /entity before the header/],
    ['a second header', [header, header, end], /second header/],
    ['the header of another group', [{...header, group: 'repo:2'}, end], /header of repo:2/],
    ['an entity after the end line', [header, end, issue], /after the end line/],
    ['a second end line', [header, end, end], /after the end line/],
    ['an end line before the header', [end, header], /before the header/],
    ['an unknown line type', [header, {type: 'more'}, end], /unknown line type/],
  ])('refuses %s', async (_what, lines, err) => {
    await expect(parseLoaded(body(...lines), 'repo:1')).rejects.toThrow(err);
  });
});
