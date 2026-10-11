// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, expect, test, vi} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Comment, Issue, Label, PullRequest, Repository} from '../../protocol/types.gen.ts';
import {StatusEvent} from './Timeline.tsx';

const state = vi.hoisted(() => ({pool: undefined as Pool | undefined}));
vi.mock('../issues/cells.tsx', async (original) => ({...await original<object>(), usePool: () => state.pool}));
vi.mock('../code/nav.tsx', () => ({CodeLink: ({owner, repo, to, children}: {owner: string; repo: string; to: string; children: ReactNode}) =>
  <a href={`/-/next/code/${owner}/${repo}/${to}/-`}>{children}</a>}));
vi.mock('./Sidebar.tsx', async (original) => ({...await original<object>(), IssueLink: ({id}: {id: number}) => <a href={`pulls/${String(id)}`}>#{id}</a>}));

const date = '2026-01-01T00:00:00Z';
const event = (extra: Partial<Comment> = {}) => ({id: 20, issue_id: 1, type: 'close', commit_id: '', ref_repo_id: 0, ref_issue_id: 0, ref_is_pull: false, poster_id: 1, created_at: date, ...extra}) as Comment;

beforeEach(() => {
  state.pool = new Pool();
  state.pool.put('Issue', 1, 'repo:1', 1, {id: 1, repo_id: 1} as Issue);
  state.pool.put('Repository', 1, 'repo:1', 1, {id: 1, owner_name: 'dev', name: 'project'} as Repository);
});

test('manual status changes stay plain', () => {
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this');
  expect(renderToStaticMarkup(<StatusEvent d={event({type: 'reopen'})}/>)).toBe('reopened this');
});

test('commit status changes link the SHA and subject as text', () => {
  const sha = 'abcdef123456789';
  state.pool?.put('Comment', 19, 'issue:1', 1, event({id: 19, type: 'commit_ref', commit_id: sha, body_html: '<a>Fix &lt;bug&gt;</a>'}));
  const html = renderToStaticMarkup(<StatusEvent d={event({commit_id: sha})}/>);
  expect(html).toContain('closed this in ');
  expect(html).toContain(`/commit/${sha}/-`);
  expect(html).toContain('abcdef1');
  expect(html).toContain('Fix &lt;bug&gt;');
  expect(renderToStaticMarkup(<StatusEvent d={event({type: 'reopen', commit_id: sha})}/>)).toContain('reopened this in ');
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toContain(`/commit/${sha}/-`);
});

test('known closing pulls link alongside their merge commit, in the source repository', () => {
  const sha = 'abcdef123456789';
  state.pool?.put('Repository', 2, 'repo:2', 1, {id: 2, owner_name: 'dev', name: 'source'} as Repository);
  state.pool?.put('PullRequest', 3, 'repo:2', 1, {id: 3, issue_id: 42, base_repo_id: 2, merge_commit_sha: sha} as PullRequest);
  const html = renderToStaticMarkup(<StatusEvent d={event({commit_id: sha, ref_repo_id: 2})}/>);
  expect(html).toContain(`/dev/source/commit/${sha}/-`);
  expect(html).toContain('href="pulls/42"');
  expect(html).toContain('#42');
});

test('a stale commit reference cannot attach to a manual close', () => {
  state.pool?.put('Comment', 19, 'issue:1', 1, event({id: 19, type: 'commit_ref', commit_id: 'abcdef1', created_at: '2025-01-01T00:00:00Z'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this');
});

test('a close with the closer\'s "Duplicate of #N" comment reads as closed as a duplicate (#216)', () => {
  state.pool?.put('Issue', 5, 'repo:1', 1, {id: 5, repo_id: 1, number: 119} as Issue);
  state.pool?.put('Comment', 19, 'issue:1', 1, event({id: 19, type: 'comment', body: 'Duplicate of #119\n\nSame crash.'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this as a duplicate of <a href="pulls/5">#5</a>');
  // Not on this device: the number.
  state.pool?.put('Comment', 19, 'issue:1', 2, event({id: 19, type: 'comment', body: 'duplicate of #7'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this as a duplicate of #7');
  // Someone else's comment, or one long before, is not a reason.
  state.pool?.put('Comment', 19, 'issue:1', 3, event({id: 19, type: 'comment', body: 'Duplicate of #119', poster_id: 2}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this');
  state.pool?.put('Comment', 19, 'issue:1', 4, event({id: 19, type: 'comment', body: 'Duplicate of #119', created_at: '2025-01-01T00:00:00Z'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this');
});

test('a close with a canceled workflow status set by the closer reads as not planned (#216)', () => {
  const label = (id: number, name: string) => ({id, repo_id: 1, name, exclusive: true}) as Label;
  state.pool?.put('Label', 2, 'repo:1', 1, label(2, 'status/Canceled'));
  state.pool?.put('Label', 3, 'repo:1', 1, label(3, 'status/Done'));
  state.pool?.put('Comment', 18, 'issue:1', 1, event({id: 18, type: 'label', label_id: 3, body: '1'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this');
  state.pool?.put('Comment', 19, 'issue:1', 1, event({id: 19, type: 'label', label_id: 2, body: '1'}));
  expect(renderToStaticMarkup(<StatusEvent d={event()}/>)).toBe('closed this as not planned');
});
