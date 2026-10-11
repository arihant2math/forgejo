// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {comment, fakeSession, issue} from '../../test/fakeSession.ts';
import {CommandPick} from '../../ui/Command.tsx';
import {recentActivityRepo} from './CreateIssue.tsx';

test('repository picker opens on the current repository, not the first alphabetically', () => {
  const first = vi.fn();
  const current = vi.fn();
  render(<CommandPick label="Repository" placeholder="Repository…" empty="No repositories" onClose={vi.fn()}
    options={[
      {value: '1', label: 'acme/atlas', checked: false, onSelect: first},
      {value: '2', label: 'dev/q3r2', checked: true, onSelect: current},
    ]}/>);
  expect(screen.getByRole('option', {name: 'dev/q3r2'}).getAttribute('data-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('combobox'), {key: 'Enter'});
  expect(current).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

test('fresh-device repository follows the user’s synced activity in eligible repositories', () => {
  const session = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), session);
  const d = session.data;
  d.put('Issue', 'repo:10', issue(1, 10, 1, 'Mine', {poster_id: 1, created_at: '2026-10-01T00:00:00Z'}));
  d.put('Issue', 'repo:20', issue(2, 20, 1, 'Theirs', {poster_id: 2, created_at: '2026-10-03T00:00:00Z'}));
  expect(recentActivityRepo(app, [{id: 10}, {id: 20}])).toBe(10);
  d.put('Comment', 'repo:20', comment(1, 2, 'Worked here', {poster_id: 1, created_at: '2026-10-04T00:00:00Z'}));
  expect(recentActivityRepo(app, [{id: 10}, {id: 20}])).toBe(20);
  expect(recentActivityRepo(app, [{id: 10}])).toBe(10);
  expect(recentActivityRepo(app, [{id: 30}])).toBe(0);
});
