// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {comment, fakeSession, issue} from '../../test/fakeSession.ts';
import {Button} from '@primer/react';
import {cloneElement} from 'react';
import {FilteredSelect} from './FilteredSelect.tsx';
import {recentActivityRepo} from './CreateIssue.tsx';

test('repository picker opens on the current repository, not the first alphabetically', async () => {
  const choose = vi.fn();
  const items = [{id: 1, text: 'acme/atlas'}, {id: 2, text: 'dev/q3r2'}];
  render(<FilteredSelect title="Repository" placeholderText="Repository…" items={items} selected={{id: 2, text: 'dev/q3r2'}}
    onSelectedChange={choose} renderAnchor={(props) => cloneElement(<Button>Repository</Button>, props)}/>);
  fireEvent.click(screen.getByRole('button', {name: 'dev/q3r2'}));
  const current = await screen.findByRole('option', {name: 'dev/q3r2'});
  expect(current.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyPress(screen.getByRole('combobox', {name: 'Repository…'}), {key: 'Enter', charCode: 13});
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({id: 2}));
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
