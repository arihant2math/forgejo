// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, render, screen, waitFor} from '@testing-library/react';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {expect, test, vi} from 'vitest';
import {useLoad} from './hooks.ts';

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

test('connected, a dropped request is asked again on its own; one that keeps failing says so with a Retry, not "offline" (#196)', async () => {
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
    // One failure: the skeleton stays, and the second attempt shows the history.
    const first = render(<View k="once"/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Not available offline')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('history')).toBeTruthy();
    first.unmount();
    // Failing every time: after the automatic retries, "Could not load" with a Retry that asks again.
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
