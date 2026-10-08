// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {autorun, runInAction} from 'mobx';
import {describe, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {KeyedFlags} from './flags.ts';
import {IssueListModel} from './list.ts';

function setup() {
  const session = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), session);
  const d = session.data;
  const dev = user(1, 'dev');
  d.put('User', 'profiles:public', dev);
  d.put('Repository', 'repo:10', repo(10, dev, 'big'));
  for (let i = 1; i <= 5; i++) d.put('Issue', 'repo:10', issue(i, 10, i, `Issue ${String(i)}`, {created_at: `2026-01-0${String(i)}T00:00:00Z`}));
  d.put('Issue', 'repo:10', issue(6, 10, 6, 'A pull', {is_pull: true}));
  const {overlay} = editing(app);
  const model = new IssueListModel(app, overlay, {kind: 'repo', repoId: 10, pulls: false});
  model.setSearch({});
  return {app, d, overlay, model};
}

describe('IssueListModel', () => {
  test('rows from the pool; an overlay change shows in the same reaction; the same rows keep their identity', async () => {
    const {d, overlay, model} = setup();
    const results: number[][] = [];
    const off = autorun(() => {
      results.push(model.result.get().ids);
    });
    expect(results).toEqual([[5, 4, 3, 2, 1]]);
    // Optimistic close: synchronously out of the open list.
    overlay.add('i1', [{t: 'field', model: 'Issue', id: 3, field: 'state', value: 'closed'}]);
    expect(results.at(-1)).toEqual([5, 4, 2, 1]);
    // A title change of a listed issue: recomputed (coalesced, next frame) but the same rows — no new result.
    const before = results.length;
    d.put('Issue', 'repo:10', issue(2, 10, 2, 'Renamed', {created_at: '2026-01-02T00:00:00Z'}));
    await new Promise((r) => setTimeout(r, 40));
    expect(results.length).toBe(before);
    // A new issue arrives from the server: the next frame lists it.
    d.put('Issue', 'repo:10', issue(9, 10, 9, 'New', {created_at: '2026-02-01T00:00:00Z'}));
    await vi.waitFor(() => {
      expect(results.at(-1)).toEqual([9, 5, 4, 2, 1]);
    });
    // The query follows the URL.
    model.setSearch({state: 'all', sort: 'oldest'});
    expect(results.at(-1)).toEqual([1, 2, 3, 4, 5, 9]);
    off();
    model.dispose();
  });

  test('many pool batches in one frame recompute once', async () => {
    const {d, model} = setup();
    let computations = 0;
    const off = autorun(() => {
      model.result.get();
      computations++;
    });
    for (let i = 20; i < 60; i++) d.put('Issue', 'repo:10', issue(i, 10, i, `Bulk ${String(i)}`));
    await vi.waitFor(() => {
      expect(model.result.get().ids).toHaveLength(45);
    });
    expect(computations).toBe(2);
    off();
    model.dispose();
  });
});

describe('KeyedFlags', () => {
  test('has(id) reacts to that id only', () => {
    const f = new KeyedFlags();
    const runs = {a: 0, b: 0};
    const offs = [autorun(() => {
      f.has(1);
      runs.a++;
    }), autorun(() => {
      f.has(2);
      runs.b++;
    })];
    runInAction(() => {
      f.replace([1]);
    });
    f.replace([1]);
    expect(runs).toEqual({a: 2, b: 1});
    f.toggle(2);
    expect(runs).toEqual({a: 2, b: 2});
    f.clear();
    expect(runs).toEqual({a: 3, b: 3});
    for (const o of offs) o();
  });
});
