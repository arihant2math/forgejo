// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import type {ReactNode} from 'react';
import {beforeEach, expect, test, vi} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import {shortcuts} from '../../app/shortcuts/index.ts';
import {editing} from '../../intents/session.ts';
import type {NextConfig, PullRequest} from '../../protocol/types.gen.ts';
import type {Connection} from '../../sync/client.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {APPROVAL_TITLE, ApprovalPanel} from './Approval.tsx';
import {ConvertToDraft, ReadyForReview} from './DraftControl.tsx';
import {MaintainerEdits} from './MaintainerEdits.tsx';

const mocks = vi.hoisted(() => ({online: vi.fn(), onlineWrite: vi.fn()}));
vi.mock('../../app/api.ts', async (original) => ({...await original<object>(), ...mocks}));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function setup(opts: {connection?: Connection; title?: string; author?: number; sameRepo?: boolean; merged?: boolean} = {}) {
  const session = fakeSession();
  session.data.put('Repository', 'repo:20', repo(20, user(2, 'acme'), 'website'));
  session.data.put('Issue', 'repo:20', issue(100, 20, 7, opts.title ?? 'Add the footer', {is_pull: true, poster_id: opts.author ?? 1}));
  session.data.put('PullRequest', 'repo:20', {
    id: 50, issue_id: 100, number: 7, status: 'mergeable', head_repo_id: opts.sameRepo ? 20 : 21, base_repo_id: 20, head_branch: 'feat', base_branch: 'main', merge_base: '',
    allow_maintainer_edit: false, merged: opts.merged ?? false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0,
  } satisfies PullRequest);
  runInAction(() => { session.data.status.connection = opts.connection ?? 'live'; });
  const app = createApp(config, session);
  const entity = session.data.pool.model('Issue').get(100);
  if (!entity) throw new Error('no issue');
  const wrap = (node: ReactNode) => render(<AppContext.Provider value={app}>{node}</AppContext.Provider>);
  return {session, app, entity, wrap};
}

beforeEach(() => {
  mocks.online.mockReset().mockResolvedValue(undefined);
  mocks.onlineWrite.mockReset().mockResolvedValue(undefined);
});

test.each([['Approve once', 'once'], ['Approve always', 'always'], ['Deny', 'deny']] as const)('approval: %s sends the trust decision', async (name, trust) => {
  const {wrap} = setup();
  wrap(<ApprovalPanel issueId={100} actions={{need_approval: true, can_decide: true, poster_trust: 'no'}} waiting/>);
  expect(screen.getByRole('region', {name: APPROVAL_TITLE})).toBeTruthy();
  // Banner renders responsive action groups; CSS hides one group in the browser.
  const button = screen.getAllByRole('button', {name})[0];
  if (!button) throw new Error(`No button: ${name}`);
  fireEvent.click(button);
  await waitFor(() => { expect(mocks.online).toHaveBeenCalledOnce(); });
  expect(mocks.online.mock.calls[0]?.[1]).toEqual({method: 'POST', api: 'sync', path: '/issues/100/action-trust', body: {trust}});
});

test.each(['offline', 'unreachable'] as const)('approval: %s actions remain focusable but never send a request', (connection) => {
  const {wrap} = setup({connection});
  wrap(<ApprovalPanel issueId={100} actions={{need_approval: true, can_decide: true, poster_trust: 'no'}} waiting/>);
  expect(screen.getByText('Approving workflows needs a connection: it is not queued offline.', {selector: 'p'})).toBeTruthy();
  for (const name of ['Approve once', 'Approve always', 'Deny']) {
    for (const button of screen.getAllByRole('button', {name})) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(button);
    }
  }
  expect(mocks.online).not.toHaveBeenCalled();
});

test('approval: a reader sees the explanation without maintainer actions', () => {
  const {wrap} = setup();
  wrap(<ApprovalPanel issueId={100} actions={{need_approval: true, can_decide: false, poster_trust: 'no'}} waiting/>);
  expect(screen.getByText(/must approve them/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Approve once'})).toBeNull();
});

test('approval: revoking explicit trust requires a connection', async () => {
  const {session, wrap} = setup({connection: 'offline'});
  wrap(<ApprovalPanel issueId={100} actions={{need_approval: false, can_decide: true, poster_trust: 'explicitly'}} waiting={false}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Revoke'}));
  expect(mocks.online).not.toHaveBeenCalled();
  act(() => { runInAction(() => { session.data.status.connection = 'live'; }); });
  fireEvent.click(screen.getByRole('button', {name: 'Revoke'}));
  await waitFor(() => { expect(mocks.online).toHaveBeenCalledOnce(); });
  expect(mocks.online.mock.calls[0]?.[1]).toMatchObject({body: {trust: 'revoke'}});
});

test('maintainer edits: a fork author can change permissions, with failure feedback', async () => {
  mocks.onlineWrite.mockRejectedValue(new Error('refused'));
  const {wrap, entity} = setup();
  wrap(<MaintainerEdits issue={entity}/>);
  const checkbox = screen.getByRole('checkbox', {name: 'Allow edits by maintainers'}) as HTMLInputElement;
  fireEvent.click(checkbox);
  // The choice shows while it is sent, and reverts when it fails.
  expect(checkbox.checked).toBe(true);
  expect(mocks.onlineWrite.mock.calls[0]?.[1]).toMatchObject({method: 'PATCH', path: '/repos/acme/website/pulls/7', body: {allow_maintainer_edit: true}});
  expect(await screen.findByRole('region', {name: 'Update failed'})).toBeTruthy();
  expect(checkbox.checked).toBe(false);
  expect(screen.getByText('Could not change maintainer permissions. Try again.')).toBeTruthy();
});

test.each(['offline', 'unreachable'] as const)('maintainer edits: %s disables the checkbox and explains why', (connection) => {
  const {wrap, entity} = setup({connection});
  wrap(<MaintainerEdits issue={entity}/>);
  const checkbox = screen.getByRole('checkbox', {name: 'Allow edits by maintainers'}) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText('Changing permissions requires a connection.')).toBeTruthy();
  fireEvent.click(checkbox);
  expect(mocks.onlineWrite).not.toHaveBeenCalled();
});

test.each([{author: 3}, {sameRepo: true}, {merged: true}])('maintainer edits: not offered outside an unmerged fork owned by the viewer (%j)', (opts) => {
  const {wrap, entity} = setup(opts);
  wrap(<MaintainerEdits issue={entity}/>);
  expect(screen.queryByRole('checkbox', {name: 'Allow edits by maintainers'})).toBeNull();
});

test('draft: "Convert to draft" queues a title intent offline, "Ready for review" undoes it, and the palette action follows', async () => {
  const {wrap, entity, app} = setup({connection: 'offline'});
  const edits = editing(app);
  const submit = vi.spyOn(edits.intents, 'submit');
  wrap(<><ConvertToDraft issue={entity}/><ReadyForReview issue={entity}/></>);
  expect(shortcuts.bound().has('pull.draft')).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Convert to draft'}));
  expect(submit).toHaveBeenCalledWith({kind: 'issue.title', issueId: 100, repoId: 20, title: 'WIP: Add the footer', base: 'Add the footer'});
  expect(await screen.findByRole('button', {name: 'Ready for review'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Convert to draft'})).toBeNull();
  expect(shortcuts.bound().has('pull.ready')).toBe(true);
  expect(shortcuts.bound().has('pull.draft')).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Ready for review'}));
  expect(submit).toHaveBeenLastCalledWith({kind: 'issue.title', issueId: 100, repoId: 20, title: 'Add the footer', base: 'WIP: Add the footer'});
});
