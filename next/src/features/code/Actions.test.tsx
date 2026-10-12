// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {ActionRun, ActionRunJob, NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const SHA = 'd'.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openRun(path: string) {
  vi.stubGlobal('IntersectionObserver', class {
    observe() { /* artifacts load once visible */ }
    disconnect() { /* nothing observed */ }
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {headers: {'Content-Type': 'application/json'}}))));
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  Object.assign(s.data, {tailLog: () => () => undefined});
  const acme = user(1, 'acme');
  s.data.put('User', 'profile:1', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  s.data.put('ActionRun', 'repo:20', {
    id: 4, repo_id: 20, owner_id: 1, title: 'Fix the build', workflow_id: 'ci.yml', run_number: 7, trigger_user_id: 1, ref: 'refs/heads/main', commit_sha: SHA,
    event: 'push', trigger_event: 'push', status: 'failure', is_fork_pull_request: false, pull_request_id: 0, need_approval: false, approved_by: 0, created_at: T, updated_at: T,
  } satisfies ActionRun);
  for (const [id, name, status] of [[40, 'lint', 'success'], [41, 'test', 'failure']] as const) {
    s.data.put('ActionRunJob', 'repo:20', {
      id, run_id: 4, repo_id: 20, owner_id: 1, commit_sha: SHA, name, attempt: 1, job_id: name, needs: [], runs_on: [], task_id: 0, status, created_at: T, updated_at: T,
    } satisfies ActionRunJob);
  }
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
}

test('the run page lists its jobs in a NavList, opens on the failed one, and re-runs jobs from it', async () => {
  await openRun('/acme/atlas/actions/runs/7');
  const jobs = await screen.findByRole('navigation', {name: 'Jobs'});
  const failed = within(jobs).getByRole('link', {name: /^test, Failed/});
  expect(failed.getAttribute('aria-current')).toBe('page');
  expect(within(jobs).getByRole('link', {name: /^lint, Succeeded/}).getAttribute('aria-current')).not.toBe('page');
  expect(within(jobs).getByRole('button', {name: 'Re-run test'})).toBeTruthy();
  // The header holds the run's control only.
  expect(screen.getByRole('button', {name: 'Re-run jobs'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Re-run job'})).toBeNull();
});
