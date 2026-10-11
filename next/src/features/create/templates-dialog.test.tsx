// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {openCreate} from '../../app/create.ts';
import {fallbackConfig} from '../../app/config.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';
import type {IssueTemplate} from './templates.ts';

const template: IssueTemplate = {name: 'Bug report', about: 'Report a problem', title: '[Bug] ', labels: [], assignees: ['alice'], content: '', file_name: '.forgejo/ISSUE_TEMPLATE/bug.yaml', body: [
  {type: 'input', id: 'version', attributes: {label: 'Version'}, validations: {required: true}},
  {type: 'checkboxes', id: 'checks', attributes: {label: 'Checks', options: [{label: 'I searched', required: true}]}},
]};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

async function show(path: string, chosenTemplate = template) {
  const s = fakeSession({userId: 1, workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  const me = user(1, 'alice');
  s.data.put('User', 'profile:1', me);
  s.data.put('Access', 'user:1', {id: 1, repo_id: 20, user_id: 1, permission: 'write'});
  s.data.put('Label', 'repo:20', {id: 3, repo_id: 20, org_id: 0, name: 'bug', exclusive: false, description: '', color: 'd73a4a', num_issues: 0, num_closed_issues: 0, created_at: T});
  s.data.put('Repository', 'repo:20', repo(20, user(2, 'acme', 'organization'), 'website'));
  s.auth.token = () => Promise.resolve('token');
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const value = input.endsWith('/issue_templates') ? [chosenTemplate] : input.endsWith('/issue_config') ? {blank_issues_enabled: false, contact_links: [{name: 'Support', about: 'Ask here', url: 'https://example.org/support'}]} : input.endsWith('/assignees') ? [{id: 1, login: 'alice'}] : input.includes('/branches/') ? {commit: {id: 'a'.repeat(40)}} : {};
    return Promise.resolve(new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp(fallbackConfig(), s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return app;
}

test('new issue URL opens the template picker, respects config and validates before queuing', async () => {
  const app = await show('/acme/website/issues/new');
  const option = await screen.findByRole('option', {name: /Bug report/});
  expect(screen.queryByRole('option', {name: 'Blank issue'})).toBeNull();
  expect(screen.getByRole('link', {name: /Support/}).getAttribute('target')).toBe('_blank');
  fireEvent.click(option);
  expect((await screen.findByRole<HTMLInputElement>('textbox', {name: 'Title'})).value).toBe('[Bug] ');
  const submit = vi.spyOn(editing(app).intents, 'submit');
  fireEvent.click(screen.getByRole('button', {name: 'Create issue'}));
  expect(await screen.findAllByText('Complete this required field.')).toHaveLength(2);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', {name: 'Version'}), {target: {value: '2.0'}});
  fireEvent.click(screen.getByRole('checkbox', {name: 'I searched'}));
  fireEvent.click(screen.getByRole('button', {name: 'Create issue'}));
  await waitFor(() => { expect(submit).toHaveBeenCalledWith(expect.objectContaining({kind: 'issue.create', title: '[Bug]', body: '### Version\n\n2.0\n\n### Checks\n\n- [x] I searched\n\n', assigneeIds: [1]})); });
});

test('template query opens its form directly and field drafts survive closing offline', async () => {
  const app = await show('/acme/website/issues/new?template=bug.yaml');
  const version = await screen.findByRole<HTMLInputElement>('textbox', {name: 'Version'});
  expect(screen.queryByRole('combobox', {name: 'Issue templates'})).toBeNull();
  fireEvent.change(version, {target: {value: '3.0'}});
  expect(version.value).toBe('3.0');
  fireEvent.click(screen.getByRole('checkbox', {name: 'I searched'}));
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  await waitFor(() => { expect(editing(app).intents.drafts.has('text:new-issue:20:template')).toBe(true); });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => { openCreate(app, 20); });
  expect((await screen.findByRole<HTMLInputElement>('textbox', {name: 'Version'})).value).toBe('3.0');
  expect((screen.getByRole('checkbox', {name: 'I searched'}) as HTMLInputElement).checked).toBe(true);
});

test('markdown templates prefill body, labels and assignees', async () => {
  const app = await show('/acme/website/issues/new?template=bug.md', {...template, file_name: 'bug.md', body: [], labels: ['bug'], content: '## What happened?'});
  expect((await screen.findByRole<HTMLTextAreaElement>('textbox', {name: 'Description'})).value).toBe('## What happened?');
  const submit = vi.spyOn(editing(app).intents, 'submit');
  fireEvent.click(screen.getByRole('button', {name: 'Create issue'}));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({body: '## What happened?', labelIds: [3], assigneeIds: [1]}));
});
