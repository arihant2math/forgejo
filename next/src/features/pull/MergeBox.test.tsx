// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import type {APIMergeCheck, ActionRun, CommitStatus, NextConfig, PullRequest, RepoUnit} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';
import {TooltipProvider} from '../../ui/index.ts';
import {MergeBox} from './Pull.tsx';

const mocks = vi.hoisted(() => ({online: vi.fn(), deleteBranch: vi.fn()}));
vi.mock('../../app/api.ts', async (original) => ({...await original<object>(), online: mocks.online}));
vi.mock('../code/refOps.ts', async (original) => ({...await original<object>(), deleteBranch: mocks.deleteBranch}));
vi.mock('../code/nav.tsx', async (original) => ({...await original<object>(), CodeLink: ({children}: {children: ReactNode}) => <a href="#code">{children}</a>}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<object>(),
  Link: ({children, search}: {children: ReactNode; search?: {tab?: string}}) => <a href={`#tab=${search?.tab ?? ''}`}>{children}</a>,
}));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const HEAD = 'a'.repeat(40);

function pull(extra: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 50, issue_id: 100, number: 7, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: 'feat', base_branch: 'main', merge_base: 'b'.repeat(40),
    allow_maintainer_edit: false, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0, ...extra,
  };
}

function check(extra: Partial<APIMergeCheck> = {}): APIMergeCheck {
  return {mergeable: true, allow_merge: true, head_repo: 'acme/website', head_branch_exists: true, branch_deletable: true, ...extra};
}

/** The pull request page's merge box for acme/website#7, with Forgejo answering the merge check with `answer`. */
function setup(opts: {pr?: Partial<PullRequest>; title?: string; state?: string; answer?: APIMergeCheck; unit?: Record<string, unknown>; statuses?: Partial<CommitStatus>[]; runs?: Partial<ActionRun>[]} = {}) {
  const s = fakeSession();
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  // alice administers acme/website (a writer here: the server decides what protection allows, not this).
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'} as never);
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, opts.title ?? 'Add the footer', {is_pull: true, state: opts.state ?? 'open', poster_id: 3}));
  s.data.put('PullRequest', 'repo:20', pull(opts.pr));
  s.data.put('Branch', 'repo:20', {id: 9, repo_id: 20, name: 'feat', commit_id: HEAD, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T});
  s.data.put('RepoUnit', 'repo:20', {id: 3, repo_id: 20, type: 'pulls', config: {AllowMerge: true, AllowSquash: true, DefaultMergeStyle: 'merge', ...opts.unit}, default_permissions: '', created_at: T} as RepoUnit);
  (opts.statuses ?? []).forEach((st, i) => {
    s.data.put('CommitStatus', 'repo:20', {id: 70 + i, repo_id: 20, sha: HEAD, index: i + 1, context: 'ci', state: 'success', target_url: '', description: '', creator_id: 1, created_at: T, updated_at: T, ...st} as CommitStatus);
  });
  (opts.runs ?? []).forEach((r, i) => {
    s.data.put('ActionRun', 'repo:20', {
      id: 80 + i, repo_id: 20, owner_id: 2, title: 'ci', workflow_id: 'ci.yml', run_number: 10 + i, trigger_user_id: 3, ref: 'refs/pull/7/head', commit_sha: HEAD, event: 'pull_request',
      trigger_event: 'pull_request', status: 'success', is_fork_pull_request: false, pull_request_id: 50, need_approval: false, approved_by: 0, created_at: T, updated_at: T, ...r,
    });
  });
  mocks.online.mockImplementation((_app: unknown, req: {api: string; path: string}) => {
    if (req.api === 'sync' && req.path === '/issues/100/merge-check') return Promise.resolve(opts.answer ?? check());
    return Promise.resolve(undefined);
  });
  const app = createApp(config, s);
  const entity = s.data.pool.model('Issue').get(100);
  if (!entity) throw new Error('no issue');
  render(<AppContext.Provider value={app}><TooltipProvider><MergeBox issue={entity}/></TooltipProvider></AppContext.Provider>);
  return {s, app};
}

/** Whether a button is disabled (and why, by its tooltip's accessible description when it has one). */
function disabled(name: string | RegExp): boolean {
  return (screen.getByRole('button', {name}) as HTMLButtonElement).disabled;
}

beforeEach(() => {
  mocks.online.mockReset();
  mocks.deleteBranch.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

test('#172: a writer gets the protection rule from the merge check (no admin-only branch_protections request), and Merge is disabled with the reason', async () => {
  setup({answer: check({protection: {
    required_approvals: 2, granted_approvals: 0, blocked_by_approvals: true, blocked_by_rejection: false, blocked_by_official_review_requests: false,
    blocked_by_outdated_branch: false, blocked_by_protected_files: false, changed_protected_files: [], required_checks: [],
  }})});
  expect(await screen.findByText(/Needs 2 more approvals \(0 of 2\)/)).toBeTruthy();
  expect(disabled(/Create a merge commit/)).toBe(true);
  const paths = mocks.online.mock.calls.map((c) => (c[1] as {path: string}).path);
  expect(paths).toEqual(['/issues/100/merge-check']);
  expect(paths.some((p) => p.includes('branch_protections'))).toBe(false);
});

test('#172: a merge allowlist without the viewer and unmet required checks are said before merging', async () => {
  setup({answer: check({allow_merge: false, protection: {
    required_approvals: 0, granted_approvals: 0, blocked_by_approvals: false, blocked_by_rejection: false, blocked_by_official_review_requests: false,
    blocked_by_outdated_branch: false, blocked_by_protected_files: false, changed_protected_files: [], required_checks: ['ci/*'],
  }})});
  expect(await screen.findByText('Only users on the merge allowlist of main can merge.')).toBeTruthy();
  expect(disabled(/Create a merge commit/)).toBe(true);
});

test('#172: when the merge check fails the box still offers what the pool knows (no thrown-away state)', async () => {
  const {s} = setup();
  mocks.online.mockImplementation(() => Promise.reject(Object.assign(new Error('nope'), {status: 403})));
  void s;
  expect(await screen.findByText('Can be merged')).toBeTruthy();
});

test('#157: a draft with failing checks says the checks failed on the Conversation tab, with a way to them', async () => {
  setup({title: 'WIP: Add the footer', statuses: [{context: 'ci/test', state: 'failure'}]});
  expect(await screen.findByText(/Draft pull requests cannot be merged/)).toBeTruthy();
  expect(screen.getByText('Some checks failed')).toBeTruthy();
  expect(screen.getByRole('link', {name: 'View checks'}).getAttribute('href')).toBe('#tab=checks');
});

test('#184: the merge dialog preselects "Delete the branch" from the repository default, and merging sends it', async () => {
  setup({unit: {DefaultDeleteBranchAfterMerge: true}});
  await waitFor(() => {
    expect(disabled(/Create a merge commit/)).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', {name: /Create a merge commit/}));
  const dialog = await screen.findByRole('dialog');
  const box = within(dialog).getByRole('checkbox', {name: 'Delete the branch feat afterwards'});
  expect(box.getAttribute('aria-checked') ?? String((box as HTMLInputElement).checked)).toBe('true');
  fireEvent.click(within(dialog).getByRole('button', {name: 'Merge'}));
  await waitFor(() => {
    expect(mocks.online.mock.calls.some((c) => (c[1] as {path: string}).path.endsWith('/pulls/7/merge'))).toBe(true);
  });
  const merge = mocks.online.mock.calls.find((c) => (c[1] as {path: string}).path.endsWith('/pulls/7/merge'))?.[1] as {body: Record<string, unknown>};
  expect(merge.body).toMatchObject({Do: 'merge', delete_branch_after_merge: true});
});

test('#184: without the repository default the box stays unticked', async () => {
  setup();
  await waitFor(() => {
    expect(disabled(/Create a merge commit/)).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', {name: /Create a merge commit/}));
  const dialog = await screen.findByRole('dialog');
  const box = within(dialog).getByRole('checkbox', {name: 'Delete the branch feat afterwards'});
  expect(box.getAttribute('aria-checked') ?? String((box as HTMLInputElement).checked)).toBe('false');
});

test('#185: a merged pull request whose branch is still there offers "Delete branch"', async () => {
  mocks.deleteBranch.mockResolvedValue(undefined);
  setup({pr: {merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: T}, state: 'closed'});
  fireEvent.click(await screen.findByRole('button', {name: 'Delete branch'}));
  const dialog = await screen.findByRole('dialog', {name: 'Delete branch'});
  fireEvent.click(within(dialog).getByRole('button', {name: 'Delete branch'}));
  await waitFor(() => {
    expect(mocks.deleteBranch).toHaveBeenCalledOnce();
  });
  expect(mocks.deleteBranch.mock.calls[0]?.slice(1)).toEqual([{id: 20, owner: 'acme', name: 'website'}, 'feat']);
});

test('#185: no "Delete branch" when Forgejo says the viewer may not delete it', async () => {
  setup({pr: {merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: T}, state: 'closed', answer: check({branch_deletable: false})});
  await waitFor(() => {
    expect(mocks.online).toHaveBeenCalled();
  });
  expect(screen.queryByRole('button', {name: 'Delete branch'})).toBeNull();
});

test('#164: a conflicted pull request says how to resolve the conflicts, with the commands and the classic page', async () => {
  setup({pr: {status: 'conflict', conflicted_files: ['README.md'], commits_behind: 3}});
  expect(await screen.findByText('How to resolve the conflicts')).toBeTruthy();
  const commands = screen.getByLabelText('Command line instructions').textContent;
  expect(commands).toContain('git switch feat');
  expect(commands).toContain('git merge origin/main');
  expect(commands).toContain('git add README.md');
  expect(commands).toContain('git push origin feat');
  expect(screen.getByText(/Editing the branch’s files on the web does not clear the conflict/)).toBeTruthy();
  expect(screen.getByRole('link', {name: /Open the merge instructions/}).getAttribute('href')).toBe('/acme/website/pulls/7?ui=classic');
});

test('#197/#200: runs waiting for approval are said in the merge box, and a maintainer approves them there', async () => {
  setup({
    runs: [{status: 'blocked', need_approval: true, is_fork_pull_request: true}],
    answer: check({actions: {need_approval: true, poster_trust: 'no', can_decide: true}}),
  });
  expect(await screen.findByText('Workflows are waiting for a maintainer’s approval')).toBeTruthy();
  expect(screen.getByText('Checks are waiting for a maintainer’s approval')).toBeTruthy();
  await waitFor(() => {
    expect(disabled('Approve once')).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', {name: 'Approve once'}));
  await waitFor(() => {
    expect(mocks.online.mock.calls.some((c) => (c[1] as {path: string}).path === '/issues/100/action-trust')).toBe(true);
  });
  const req = mocks.online.mock.calls.find((c) => (c[1] as {path: string}).path === '/issues/100/action-trust')?.[1] as unknown;
  expect(req).toMatchObject({method: 'POST', api: 'sync', body: {trust: 'once'}});
});

test('#197: a reader is told who must approve, without the buttons', async () => {
  setup({
    runs: [{status: 'blocked', need_approval: true, is_fork_pull_request: true}],
    answer: check({actions: {need_approval: true, poster_trust: 'no', can_decide: false}}),
  });
  expect(await screen.findByText(/must approve them/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Approve once'})).toBeNull();
});
