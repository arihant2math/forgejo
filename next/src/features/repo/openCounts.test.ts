// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {autorun} from 'mobx';
import {expect, test, vi} from 'vitest';
import {Pool} from '../../data/pool.ts';
import {Overlay} from '../../intents/overlay.ts';
import {issue} from '../../test/fakeSession.ts';
import {openCounts} from './openCounts.ts';

function setup() {
  const pool = new Pool();
  pool.batch(() => {
    pool.load('Issue', [
      {id: 1, g: 'repo:1', v: 1, d: issue(1, 1, 1, 'Open issue')},
      {id: 2, g: 'repo:1', v: 1, d: issue(2, 1, 2, 'Closed issue', {state: 'closed'})},
      {id: 3, g: 'repo:1', v: 1, d: issue(3, 1, 3, 'Open pull', {is_pull: true})},
      {id: 4, g: 'repo:2', v: 1, d: issue(4, 2, 1, 'Elsewhere')},
    ]);
  });
  return {pool, overlay: new Overlay()};
}

test('counts open issues and pulls of one repository, local edits included', () => {
  const {pool, overlay} = setup();
  const counts = openCounts(pool, overlay, 1);
  const seen: unknown[] = [];
  const stop = autorun(() => { seen.push(counts.get()); });
  expect(seen).toEqual([{issues: 1, pulls: 1}]);
  overlay.add('close', [{t: 'field', model: 'Issue', id: 1, field: 'state', value: 'closed'}]);
  expect(seen.at(-1)).toEqual({issues: 0, pulls: 1});
  stop();
});

test('pool changes recount once per frame, and only a changed total notifies', () => {
  vi.useFakeTimers({toFake: ['requestAnimationFrame', 'setTimeout']});
  try {
    const {pool, overlay} = setup();
    const counts = openCounts(pool, overlay, 1);
    let runs = 0;
    const stop = autorun(() => { counts.get(); runs++; });
    pool.put('Issue', 1, 'repo:1', 2, issue(1, 1, 1, 'Renamed'));
    pool.put('Issue', 4, 'repo:2', 2, issue(4, 2, 1, 'Elsewhere', {state: 'closed'}));
    vi.runAllTimers();
    expect(runs).toBe(1);
    pool.put('Issue', 2, 'repo:1', 2, issue(2, 1, 2, 'Reopened'));
    pool.put('Issue', 5, 'repo:1', 1, issue(5, 1, 4, 'New', {is_pull: true}));
    expect(counts.get()).toEqual({issues: 1, pulls: 1});
    vi.runAllTimers();
    expect(runs).toBe(2);
    expect(counts.get()).toEqual({issues: 2, pulls: 2});
    stop();
  } finally { vi.useRealTimers(); }
});

test('follows the pool only while observed', () => {
  const {pool, overlay} = setup();
  const original = pool.onApplied.bind(pool);
  let listening = 0;
  vi.spyOn(pool, 'onApplied').mockImplementation((fn) => {
    listening++;
    const off = original(fn);
    return () => { listening--; off(); };
  });
  const counts = openCounts(pool, overlay, 1);
  expect(openCounts(pool, overlay, 1)).toBe(counts);
  expect(listening).toBe(0);
  const stop = autorun(() => { counts.get(); });
  expect(listening).toBe(1);
  stop();
  expect(listening).toBe(0);
});
