// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {act, render, screen, waitFor} from '@testing-library/react';
import {autorun, observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {expect, test, vi} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Branch, Release, Repository} from '../../protocol/types.gen.ts';
import {branchByName, refTable, useLoad} from './hooks.ts';

const app = vi.hoisted(() => ({session: {data: {status: {connection: 'unreachable'}}}}));
vi.mock('../../app/store.ts', () => ({useApp: () => app}));

test('a known stall skips skeletons, keeps cached content, and retries on recovery', async () => {
  app.session.data.status = observable({connection: 'unreachable'});
  const load = vi.fn(() => new Promise<string>(() => undefined));
  const View = observer(function View({cached = false}: {cached?: boolean}) {
    const value = useLoad('tree', () => cached ? 'cached files' : undefined, load);
    return <div>{value.state === 'ready' ? value.value : value.state}</div>;
  });
  const view = render(<View/>);
  expect(screen.getByText('offline')).toBeTruthy();
  act(() => { runInAction(() => { app.session.data.status.connection = 'live'; }); });
  await waitFor(() => { expect(load).toHaveBeenCalledTimes(2); });
  view.unmount();
  runInAction(() => { app.session.data.status.connection = 'unreachable'; });
  render(<View cached/>);
  expect(screen.getByText('cached files')).toBeTruthy();
});

test('connected, a dropped request is asked again on its own; one that keeps failing says so with a Retry, not "offline"', async () => {
  vi.useFakeTimers();
  try {
    app.session.data.status = observable({connection: 'live'});
    const {NotCached} = await import('../../code/source.ts');
    const {Unloaded} = await import('./states.tsx');
    let fail = 1;
    const load = vi.fn(() => (fail-- > 0 ? Promise.reject(new NotCached('Forgejo could not be reached.')) : Promise.resolve('history')));
    const View = observer(function View({k}: {k: string}) {
      const value = useLoad(k, () => undefined, load);
      return value.state === 'ready' ? <div>{value.value}</div> : <Unloaded loaded={value} what="This history"/>;
    });
    const first = render(<View k="once"/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Not available offline')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('history')).toBeTruthy();
    first.unmount();
    load.mockClear();
    fail = 99;
    render(<View k="always"/>);
    for (const ms of [0, 1000, 3000]) await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Could not load')).toBeTruthy();
    expect(screen.queryByText('Not available offline')).toBeNull();
    fail = 0;
    await act(async () => {
      screen.getByRole('button', {name: 'Retry'}).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(4);
    expect(screen.getByText('history')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test('a refusal is not asked again (a 404 stays not found)', async () => {
  vi.useFakeTimers();
  try {
    app.session.data.status = observable({connection: 'live'});
    const load = vi.fn(() => Promise.reject(Object.assign(new Error('Not Found'), {status: 404})));
    const View = observer(function View() {
      const value = useLoad('missing', () => undefined, load);
      return <div>{value.state}{value.state === 'error' && value.retry ? ' retry' : ''}</div>;
    });
    render(<View/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('error')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

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
