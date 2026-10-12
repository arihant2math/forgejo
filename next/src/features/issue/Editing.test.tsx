// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {BaseStyles, ThemeProvider} from '@primer/react';
import {afterEach, expect, test} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import {fallbackConfig} from '../../app/config.ts';
import {editing} from '../../intents/session.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {Rendered, TitleSection} from './Editing.tsx';

afterEach(cleanup);

function title() {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:20', repo(20, owner, 'website'));
  session.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Original title', {poster_id: 1}));
  const app = createApp(fallbackConfig(), session);
  const entity = session.data.pool.model('Issue').get(100);
  if (!entity) throw new Error('Missing test issue');
  render(<AppContext value={app}><ThemeProvider><BaseStyles><TitleSection issue={entity}/></BaseStyles></ThemeProvider></AppContext>);
  return app;
}

test('unsynced markdown keeps literal source in the Primer markdown container', () => {
  const {container} = render(<Rendered local text={'<script>unsafe</script>\n**waiting for Forgejo**'} html=""/>);
  expect(container.querySelector('.markdown-body')?.textContent).toBe('<script>unsafe</script>\n**waiting for Forgejo**');
  expect(container.querySelector('script')).toBeNull();
});

test('editing the title is keyboard accessible: Escape cancels, Enter queues an offline-capable edit, leaving the field does not save', () => {
  const app = title();
  fireEvent.click(screen.getByRole('button', {name: 'Edit title'}));
  const input = screen.getByRole('textbox', {name: 'Title'});
  fireEvent.change(input, {target: {value: 'Discarded title'}});
  fireEvent.blur(input);
  expect(editing(app).intents.records.size).toBe(0);
  fireEvent.keyDown(input, {key: 'Escape'});
  expect(screen.getByRole('heading', {name: /Original title/})).toBeTruthy();
  expect(editing(app).intents.records.size).toBe(0);
  fireEvent.click(screen.getByRole('button', {name: 'Edit title'}));
  const next = screen.getByRole('textbox', {name: 'Title'});
  fireEvent.change(next, {target: {value: 'New title'}});
  fireEvent.keyDown(next, {key: 'Enter'});
  expect([...editing(app).intents.records.values()].map((record) => record.intent)).toContainEqual(expect.objectContaining({kind: 'issue.title', title: 'New title', base: 'Original title'}));
});

test('the title shows its number, and Save and Cancel end editing', () => {
  const app = title();
  expect(screen.getByRole('heading', {name: 'Original title #7'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Edit title'}));
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(screen.queryByRole('textbox', {name: 'Title'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Edit title'}));
  fireEvent.change(screen.getByRole('textbox', {name: 'Title'}), {target: {value: 'Saved title'}});
  fireEvent.click(screen.getByRole('button', {name: 'Save'}));
  expect(screen.queryByRole('textbox', {name: 'Title'})).toBeNull();
  expect([...editing(app).intents.records.values()].map((record) => record.intent)).toContainEqual(expect.objectContaining({kind: 'issue.title', title: 'Saved title'}));
});
