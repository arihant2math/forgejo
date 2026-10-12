// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {autorun, runInAction} from 'mobx';
import {expect, test} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Branch, Release, Repository} from '../../protocol/types.gen.ts';
import {branchByName, refTable} from './hooks.ts';

const G = 'repo:1';

function branch(id: number, name: string, commit: string, extra: Partial<Branch> = {}): Branch {
  return {id, repo_id: 1, name, commit_id: commit, commit_message: name, commit_time: '2026-01-01T00:00:00Z', is_deleted: false, pusher_id: 0, ...extra} as Branch;
}

function tag(id: number, name: string, sha: string): Release {
  return {id, repo_id: 1, tag_name: name, sha, draft: false} as Release;
}

test('refTable is one sorted derivation per repository that observers share', () => {
  const pool = new Pool();
  let v = 1;
  runInAction(() => {
    pool.put('Repository', 1, G, v++, {id: 1, default_branch: 'main'} as Repository);
    pool.put('Branch', 1, G, v++, branch(1, 'zeta', 'z'));
    pool.put('Branch', 2, G, v++, branch(2, 'main', 'm'));
    pool.put('Branch', 3, G, v++, branch(3, 'alpha', 'a'));
    pool.put('Branch', 4, G, v++, branch(4, 'gone', 'g', {is_deleted: true}));
    pool.put('Release', 1, G, v++, tag(1, 'v1.9', 's9'));
    pool.put('Release', 2, G, v++, tag(2, 'v1.10', 's10'));
  });
  const seen: unknown[] = [];
  const stop = autorun(() => { seen.push(refTable(pool, 1)); });
  const first = refTable(pool, 1);
  expect(first.branchNames).toEqual(['main', 'alpha', 'zeta']);
  expect(first.tagNames).toEqual(['v1.10', 'v1.9']);
  expect(branchByName(pool, 1).get('main')?.data.commit_id).toBe('m');
  expect(branchByName(pool, 1).has('gone')).toBe(false);
  // A field no ref depends on leaves the derivation (and its observers) alone.
  runInAction(() => { pool.put('Branch', 3, G, v++, branch(3, 'alpha', 'a', {commit_message: 'changed'})); });
  expect(seen).toHaveLength(1);
  expect(refTable(pool, 1)).toBe(first);
  runInAction(() => { pool.put('Branch', 3, G, v++, branch(3, 'alpha', 'a2')); });
  expect(seen).toHaveLength(2);
  expect(refTable(pool, 1).branches.get('alpha')).toBe('a2');
  stop();
});
