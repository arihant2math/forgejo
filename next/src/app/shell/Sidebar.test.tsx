// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {runInAction} from 'mobx';
import type {ReactNode} from 'react';
import {expect, test, vi} from 'vitest';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {OwnerGroup, owners} from './Sidebar.tsx';

const route = vi.hoisted(() => ({pathname: '/dev/r10'}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({select}: {select: (s: {location: {pathname: string}}) => unknown}) => select({location: route}),
  Link: ({children}: {children?: ReactNode}) => <a>{children}</a>,
}));
vi.mock('../store.ts', () => ({useSession: () => ({data: {pool: {model: () => ({get: () => undefined})}}})}));

test('waits for every workspace repository before displaying the sorted list', () => {
  const s = fakeSession({workspace: {
    viewer_id: 1, truncated: false, max_repos: 200,
    groups: [1, 2].map((id) => ({group: `repo:${String(id)}`, units: [], reason: 'member' as const})),
  }});
  const dev = user(1, 'dev');
  s.data.put('Repository', 'repo:1', repo(1, dev, 'zebra'));
  expect(owners(s, true)).toEqual([]);
  s.data.put('Repository', 'repo:2', repo(2, dev, 'atlas'));
  expect(owners(s).map((o) => o.repos)).toEqual([['atlas', 'zebra']]);
});

test('shows known repositories when initial sync ends even if metadata never arrives', () => {
  const s = fakeSession({workspace: {
    viewer_id: 1, truncated: false, max_repos: 200,
    groups: [1, 2].map((id) => ({group: `repo:${String(id)}`, units: [], reason: 'member' as const})),
  }});
  s.data.put('Repository', 'repo:1', repo(1, user(1, 'dev'), 'atlas'));
  runInAction(() => { s.data.status.connection = 'catching_up'; });
  expect(owners(s)).toEqual([]);
  runInAction(() => { s.data.status.connection = 'live'; });
  expect(owners(s).map((o) => o.repos)).toEqual([['atlas']]);
  runInAction(() => {
    s.data.status.connection = 'connecting';
    s.data.status.lastError = 'bootstrap repo:2: failed';
  });
  expect(owners(s).map((o) => o.repos)).toEqual([['atlas']]);
});

test('keeps a revealed repository row after navigating away', () => {
  const owner = {id: 1, login: 'dev', repos: Array.from({length: 12}, (_, i) => `r${String(i).padStart(2, '0')}`)};
  const props = {owner, open: true, onToggle: vi.fn()};
  const view = render(<OwnerGroup {...props}/>);
  expect(screen.getByText('r10')).toBeTruthy();
  route.pathname = '/other/atlas';
  view.rerender(<OwnerGroup {...props} open={false}/>);
  view.rerender(<OwnerGroup {...props}/>);
  expect(screen.getByText('r10')).toBeTruthy();
  expect(screen.getByText('1 more')).toBeTruthy();
});
