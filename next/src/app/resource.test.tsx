// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {act, render, screen, waitFor} from '@testing-library/react';
import {IDBFactory} from 'fake-indexeddb';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {sessionCache} from '../code/cache.ts';
import {openDatabase} from '../data/idb.ts';
import {LoadState} from '../components/LoadState.tsx';
import {RequestFailed} from './api.ts';
import {connectivity} from './online.ts';
import {loadResource, type Resource, useResource} from './resource.ts';

const app = vi.hoisted(() => ({session: {data: {status: {connection: 'live'}, db: undefined as unknown as IDBDatabase}}}));
vi.mock('./store.ts', () => ({useApp: () => app}));

beforeEach(async () => {
  app.session = {data: {status: observable({connection: 'live'}), db: await openDatabase(1, {factory: new IDBFactory()})}};
  runInAction(() => {
    connectivity.online = true;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const setConnection = (connection: string) => {
  act(() => {
    runInAction(() => {
      app.session.data.status.connection = connection;
    });
  });
};

function shown(r: Resource<string>): string {
  if (r.state === 'ready') return `${r.value}${r.fresh ? ' (fresh)' : ''}`;
  return r.state === 'error' ? `error ${String(r.status)}: ${r.error}` : r.state;
}

const Code = observer(function Code({k, peek, load}: {k: string | undefined; peek: () => string | undefined; load: () => Promise<string>}) {
  return <div>{shown(useResource(k, load, {peek, immutable: true}))}</div>;
});

const Settings = observer(function Settings({k, load}: {k: string; load: (signal: AbortSignal) => Promise<string>}) {
  return <div>{shown(useResource(k, load))}</div>;
});

test('immutable content in the caller’s cache is the first frame and is not asked again', async () => {
  const load = vi.fn(() => Promise.resolve('asked'));
  render(<Code k="tree:1:a" peek={() => 'cached files'} load={load}/>);
  expect(screen.getByText('cached files')).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  expect(load).not.toHaveBeenCalled();
});

test('an undefined key defers loading', async () => {
  const load = vi.fn(() => Promise.resolve('asked'));
  render(<Code k={undefined} peek={() => undefined} load={load}/>);
  await act(async () => { await Promise.resolve(); });
  expect(load).not.toHaveBeenCalled();
  expect(screen.getByText('loading')).toBeTruthy();
});

test('a cached setting shows at once, stays through a failed refresh, and a refusal replaces it', async () => {
  sessionCache(app.session.data.db).put('settings:1:hooks', 'two hooks');
  setConnection('unreachable');
  let answer: Promise<string> = Promise.reject(new RequestFailed(503, 'busy'));
  const load = vi.fn(() => answer);
  const view = render(<Settings k="settings:1:hooks" load={load}/>);
  expect(screen.getByText('two hooks')).toBeTruthy();
  await waitFor(() => { expect(load).toHaveBeenCalledTimes(1); });
  expect(screen.getByText('two hooks')).toBeTruthy();
  answer = Promise.resolve('three hooks');
  setConnection('live');
  await waitFor(() => { expect(screen.getByText('three hooks (fresh)')).toBeTruthy(); });
  expect(sessionCache(app.session.data.db).peek('settings:1:hooks')).toBe('three hooks');
  view.unmount();
  answer = Promise.reject(new RequestFailed(403, 'Forgejo refused it.'));
  render(<Settings k="settings:1:hooks" load={load}/>);
  expect(screen.getByText('three hooks')).toBeTruthy();
  await waitFor(() => { expect(screen.getByText('error 403: Forgejo refused it.')).toBeTruthy(); });
});

test('offline nothing is asked; reconnecting asks', async () => {
  act(() => {
    runInAction(() => {
      connectivity.online = false;
    });
  });
  setConnection('offline');
  const load = vi.fn(() => Promise.resolve('keys'));
  render(<Settings k="settings:1:keys" load={load}/>);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(load).not.toHaveBeenCalled();
  expect(screen.getByText('offline')).toBeTruthy();
  act(() => {
    runInAction(() => {
      connectivity.online = true;
    });
  });
  setConnection('live');
  await waitFor(() => { expect(screen.getByText('keys (fresh)')).toBeTruthy(); });
  expect(load).toHaveBeenCalledTimes(1);
});

test('a known stall skips skeletons and asks again on recovery', async () => {
  setConnection('unreachable');
  const load = vi.fn(() => new Promise<string>(() => undefined));
  render(<Code k="tree" peek={() => undefined} load={load}/>);
  expect(screen.getByText('offline')).toBeTruthy();
  setConnection('live');
  await waitFor(() => { expect(load).toHaveBeenCalledTimes(2); });
});

test('connected, a dropped request is asked again on its own; one that keeps failing says so with a Retry, not "offline"', async () => {
  vi.useFakeTimers();
  class NotCached extends Error {
    override name = 'NotCached';
  }
  let fail = 1;
  const load = vi.fn(() => (fail-- > 0 ? Promise.reject(new NotCached('Forgejo could not be reached.')) : Promise.resolve('history')));
  const View = observer(function View({k}: {k: string}) {
    const value = useResource(k, load, {peek: () => undefined, immutable: true});
    return value.state === 'ready' ? <div>{value.value}</div> : <LoadState res={value} what="This history" page/>;
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
});

test('a refusal is not asked again on its own, and its server text is shown, not internals', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const load = vi.fn(() => Promise.reject(new RequestFailed(422, 'dial unix /run/forgejo.sock: connection refused')));
    render(<Code k="missing" peek={() => undefined} load={load}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('error 422: Forgejo refused it (HTTP 422).')).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test('leaving or changing the key aborts the request and drops its late answer', async () => {
  const signals: AbortSignal[] = [];
  let answer: (v: string) => void = () => undefined;
  const load = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve) => { answer = resolve; });
  });
  const view = render(<Settings k="settings:1:a" load={load}/>);
  await waitFor(() => { expect(load).toHaveBeenCalledTimes(1); });
  const late = answer;
  view.rerender(<Settings k="settings:1:b" load={load}/>);
  await waitFor(() => { expect(load).toHaveBeenCalledTimes(2); });
  expect(signals[0]?.aborted).toBe(true);
  late('answer for a');
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('loading')).toBeTruthy();
  view.unmount();
  expect(signals[1]?.aborted).toBe(true);
});

test('a prefetched answer is shared: the view joins its request instead of asking again', async () => {
  const load = vi.fn(() => Promise.resolve('emails'));
  const asked = loadResource(app as never, 'uset:0:1:emails', load);
  expect(loadResource(app as never, 'uset:0:1:emails', load)).toBe(asked);
  const view = render(<Settings k="uset:0:1:emails" load={load}/>);
  await waitFor(() => { expect(screen.getByText('emails (fresh)')).toBeTruthy(); });
  expect(load).toHaveBeenCalledTimes(1);
  view.unmount();
  // A later visit asks again; outside React a recent answer is reused.
  render(<Settings k="uset:0:1:emails" load={load}/>);
  expect(screen.getByText('emails')).toBeTruthy();
  await waitFor(() => { expect(screen.getByText('emails (fresh)')).toBeTruthy(); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(await loadResource(app as never, 'uset:0:1:emails', load)).toBe('emails');
  expect(load).toHaveBeenCalledTimes(2);
});
