// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {render, screen, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {beforeEach, expect, test, vi} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import type {ActionRun, ActionRunJob, CommitStatus, NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

import {commitRow} from './bits.tsx';
import {apiCommitChecks, checkTarget, CommitCheckMark, CommitChecksSection, poolCommitChecks, resetCommitChecks, withChecks} from './commitChecks.tsx';

const mocks = vi.hoisted(() => ({online: vi.fn()}));
vi.mock('../../app/api.ts', async (original) => ({...await original<object>(), online: mocks.online}));
vi.mock('./nav.tsx', async (original) => ({
  ...await original<object>(),
  CodeLink: ({to, hash, label, children, className}: {to: string; hash?: string; label?: string; children: ReactNode; className?: string}) =>
    <a href={`/code/${to}${hash ? `#${hash}` : ''}`} aria-label={label} className={className}>{children}</a>,
}));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const OLD = 'd'.repeat(40);
const HEAD = 'e'.repeat(40);
const repos = {base_repo_id: 20, head_repo_id: 20};

function session() {
  const s = fakeSession();
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  return s;
}

function failedRun(s: ReturnType<typeof session>) {
  s.data.put('ActionRun', 'repo:20', {
    id: 4, repo_id: 20, owner_id: 2, title: 'server: serve .mvt tiles', workflow_id: 'ci.yml', run_number: 4, trigger_user_id: 1, ref: 'refs/pull/106/head', commit_sha: OLD,
    event: 'pull_request', trigger_event: 'pull_request', status: 'failure', is_fork_pull_request: false, pull_request_id: 0, need_approval: false, approved_by: 0, created_at: T, updated_at: T,
  } satisfies ActionRun);
  for (const [id, name, status] of [[40, 'test', 'failure'], [41, 'web', 'success']] as const) {
    s.data.put('ActionRunJob', 'repo:20', {
      id, run_id: 4, repo_id: 20, owner_id: 2, commit_sha: OLD, name, attempt: 1, job_id: name, needs: [], runs_on: [], task_id: 1, status, created_at: T, updated_at: T,
    } satisfies ActionRunJob);
  }
  s.data.put('CommitStatus', 'repo:20', {
    id: 36, repo_id: 20, index: 1, state: 'failure', sha: OLD, target_url: '/acme/atlas/actions/runs/4/jobs/0', description: 'Failing after 12s', context: 'CI / test (pull_request)',
    creator_id: 1, created_at: T, updated_at: T,
  } satisfies CommitStatus);
  s.data.put('CommitStatus', 'repo:20', {
    id: 37, repo_id: 20, index: 2, state: 'success', sha: OLD, target_url: 'https://codecov.example/acme/atlas', description: '91%', context: 'coverage/codecov',
    creator_id: 1, created_at: T, updated_at: T,
  } satisfies CommitStatus);
}

function show(s: ReturnType<typeof session>, node: ReactNode) {
  const app = createApp(config, s);
  return render(<AppContext.Provider value={app}>{node}</AppContext.Provider>);
}

beforeEach(() => {
  mocks.online.mockReset();
  resetCommitChecks();
});

test('a status target opens the run in the app when it is one of this repository\'s', () => {
  expect(checkTarget('/acme/atlas/actions/runs/4/jobs/0', 'acme', 'atlas', config)).toEqual({code: 'actions/runs/4/jobs/0'});
  expect(checkTarget('http://localhost/acme/atlas/actions/runs/4/jobs/0/attempt/2', 'acme', 'atlas', config)).toEqual({code: 'actions/runs/4/jobs/0'});
  expect(checkTarget('http://localhost/acme/atlas/actions/runs/4', 'ACME', 'Atlas', config)).toEqual({code: 'actions/runs/4'});
  expect(checkTarget('/acme/other/actions/runs/4/jobs/0', 'acme', 'atlas', config)).toEqual({href: '/acme/other/actions/runs/4/jobs/0'});
  expect(checkTarget('https://ci.example/build/9', 'acme', 'atlas', config)).toEqual({href: 'https://ci.example/build/9'});
  expect(checkTarget('javascript:alert(1)', 'acme', 'atlas', config)).toEqual({});
  expect(checkTarget('', 'acme', 'atlas', config)).toEqual({});
  const sub = {app_url: 'http://localhost/git/', app_sub_url: '/git'};
  expect(checkTarget('/git/acme/atlas/actions/runs/4/jobs/1', 'acme', 'atlas', sub)).toEqual({code: 'actions/runs/4/jobs/1'});
  expect(checkTarget('http://localhost/git/acme/atlas/actions/runs/4/jobs/1', 'acme', 'atlas', sub)).toEqual({code: 'actions/runs/4/jobs/1'});
  expect(checkTarget('http://localhost/git/acme/atlas/commit/x', 'acme', 'atlas', sub)).toEqual({href: '/git/acme/atlas/commit/x'});
});

test('an older commit\'s checks from the pool: the run\'s jobs (not their statuses again) and the other statuses', () => {
  const s = session();
  failedRun(s);
  const c = poolCommitChecks(s.data.pool, repos, OLD, 'acme', 'atlas', config);
  expect(c?.summary).toBe('failure');
  expect(c?.items.map((it) => [it.name, it.state, it.code ?? it.href])).toEqual([
    ['ci.yml / test', 'failure', 'actions/runs/4/jobs/0'],
    ['ci.yml / web', 'success', 'actions/runs/4/jobs/1'],
    ['coverage/codecov', 'success', 'https://codecov.example/acme/atlas'],
  ]);
  expect(poolCommitChecks(s.data.pool, repos, HEAD, 'acme', 'atlas', config)).toBeUndefined();
});

test('API v1\'s combined status reads the same way', () => {
  const c = apiCommitChecks({state: 'failure', statuses: [
    {id: 36, context: 'CI / test (pull_request)', status: 'failure', target_url: 'http://localhost/acme/atlas/actions/runs/4/jobs/0', description: 'Failing after 12s'},
    {id: 38, context: 'lint', status: 'pending', target_url: '', description: 'Successful in -35s'},
  ]}, 'acme', 'atlas', config);
  expect(c.summary).toBe('failure');
  expect(c.items[0]).toMatchObject({name: 'CI / test (pull_request)', state: 'failure', code: 'actions/runs/4/jobs/0'});
  expect(c.items[1]).toMatchObject({state: 'waiting', description: 'Successful'});
  expect(apiCommitChecks({state: '', statuses: []}, 'acme', 'atlas', config).summary).toBe('none');
});

test('#250: a commit row carries its check state, leading to the failed job', () => {
  const s = session();
  failedRun(s);
  const row = withChecks(commitRow, 'acme', 'atlas', repos)({sha: OLD, message: 'server: serve .mvt tiles', authorName: 'Alice', authorAvatar: '', date: T, parents: []} as never);
  show(s, <div>{row.trailing}</div>);
  const mark = screen.getByRole('link', {name: 'Some checks were not successful: ci.yml / test'});
  expect(mark.getAttribute('href')).toBe('/code/actions/runs/4/jobs/0');
  expect(screen.getByRole('img', {name: 'Some checks were not successful: ci.yml / test'})).toBeTruthy();
  expect(mocks.online).not.toHaveBeenCalled();
});

test('#250: a commit the pool has no checks for asks API v1 once, and a passed one links to the commit\'s checks', async () => {
  const s = session();
  mocks.online.mockResolvedValue({state: 'success', statuses: [{id: 1, context: 'ci', status: 'success', target_url: ''}]});
  show(s, <><CommitCheckMark owner="acme" repo="atlas" repos={repos} sha={HEAD}/><CommitCheckMark owner="acme" repo="atlas" repos={repos} sha={HEAD}/></>);
  await waitFor(() => {
    expect(screen.getAllByRole('link', {name: 'All checks have passed'})).toHaveLength(2);
  });
  expect(mocks.online).toHaveBeenCalledOnce();
  expect(mocks.online.mock.calls[0]?.[1]).toEqual({api: 'v1', path: `/repos/acme/atlas/commits/${HEAD}/status?limit=50`});
  expect(screen.getAllByRole('link', {name: 'All checks have passed'})[0]?.getAttribute('href')).toBe(`/code/commit/${HEAD}#checks`);
});

test('#250: a long list asks at most four commits at a time', async () => {
  const s = session();
  const pending: ((v: unknown) => void)[] = [];
  mocks.online.mockImplementation(() => new Promise((resolve) => {
    pending.push(resolve);
  }));
  const shas = Array.from({length: 10}, (_, i) => String(i).repeat(40));
  show(s, <>{shas.map((sha) => <CommitCheckMark key={sha} owner="acme" repo="atlas" repos={repos} sha={sha}/>)}</>);
  await waitFor(() => {
    expect(mocks.online).toHaveBeenCalledTimes(4);
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(mocks.online).toHaveBeenCalledTimes(4);
  pending.shift()?.({state: '', statuses: []});
  await waitFor(() => {
    expect(mocks.online).toHaveBeenCalledTimes(5);
  });
});

test('#250: the commit page lists the commit\'s checks with links to the run and the targets', () => {
  const s = session();
  failedRun(s);
  show(s, <CommitChecksSection owner="acme" repo="atlas" repoId={20} sha={OLD}/>);
  const section = screen.getByRole('region', {name: 'Checks'});
  expect(section.textContent).toContain('Checks · Some checks were not successful');
  expect(screen.getByRole('link', {name: 'ci.yml / test'}).getAttribute('href')).toBe('/code/actions/runs/4/jobs/0');
  expect(screen.getByRole('link', {name: 'coverage/codecov'}).getAttribute('href')).toBe('https://codecov.example/acme/atlas');
  expect(section.textContent).toContain('Failed');
  expect(section.querySelector('ul')?.classList.contains('text-base')).toBe(true);
  for (const name of ['ci.yml / test', 'coverage/codecov']) {
    expect(screen.getByRole('link', {name}).classList.contains('text-default')).toBe(true);
    expect(screen.getByRole('link', {name}).classList.contains('hover:underline')).toBe(true);
  }
  expect(screen.getByText('Failed').classList.contains('text-sm')).toBe(true);
});
