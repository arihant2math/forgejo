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
