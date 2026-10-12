// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import type {APIMergeCheck, APIMergeProtection, PullRequest} from '../../protocol/types.gen.ts';
import {runLook, runMatches} from '../code/Actions.tsx';
import {awaitsApproval} from './checks.ts';
import {conflictCommands} from './ConflictHelp.tsx';
import {globRegExp, protectionWhy, unmetChecks} from './mergeCheck.ts';

// Only Actions' status helpers are exercised, not its standalone repository page shell.
vi.mock('../code/CodePage.tsx', () => ({CodeFrame: () => null}));

const rule = (extra: Partial<APIMergeProtection> = {}): APIMergeProtection => ({
  required_approvals: 0, granted_approvals: 0, blocked_by_approvals: false, blocked_by_rejection: false, blocked_by_official_review_requests: false,
  blocked_by_outdated_branch: false, blocked_by_protected_files: false, changed_protected_files: [], required_checks: [], ...extra,
});
const check = (extra: Partial<APIMergeCheck> = {}): APIMergeCheck => ({mergeable: true, allow_merge: true, head_repo: 'a/b', head_branch_exists: true, branch_deletable: false, ...extra});

test('status check patterns are Forgejo globs', () => {
  expect(globRegExp('ci/*').test('ci/test (push)')).toBe(true);
  expect(globRegExp('ci/*').test('lint')).toBe(false);
  expect(globRegExp('ci.yml / test').test('ci.yml / test')).toBe(true);
  expect(globRegExp('build-?').test('build-1')).toBe(true);
  expect(globRegExp('{lint,test}').test('test')).toBe(true);
  expect(globRegExp('{lint,test}').test('build')).toBe(false);
  expect(globRegExp('[ab]x').test('bx')).toBe(true);
  expect(globRegExp('[!ab]x').test('bx')).toBe(false);
  expect(globRegExp('a.b').test('axb')).toBe(false);
  expect(globRegExp('\\*').test('*')).toBe(true);
});

test('a required check passes when what matches it all succeeded', () => {
  const statuses = [{context: 'ci/test', state: 'success'}, {context: 'ci/lint', state: 'failure'}, {context: 'docs', state: 'success'}];
  expect(unmetChecks(['docs'], statuses)).toEqual([]);
  expect(unmetChecks(['ci/*', 'docs', 'deploy'], statuses)).toEqual(['ci/*', 'deploy']);
  expect(unmetChecks(['ci/test'], statuses)).toEqual([]);
});

test('the protection verdict reads as the merge API would refuse', () => {
  expect(protectionWhy(undefined, 'main', [])).toBeUndefined();
  expect(protectionWhy(check(), 'main', [])).toBeUndefined();
  expect(protectionWhy(check({allow_merge: false}), 'main', [])).toBe('You may not merge into main.');
  expect(protectionWhy(check({allow_merge: false, protection: rule()}), 'main', [])).toBe('Only users on the merge allowlist of main can merge.');
  expect(protectionWhy(check({protection: rule({required_approvals: 2, granted_approvals: 1, blocked_by_approvals: true})}), 'main', [])).toBe('Needs 1 more approval (1 of 2).');
  expect(protectionWhy(check({protection: rule({blocked_by_rejection: true})}), 'main', [])).toBe('Blocked by a change request.');
  expect(protectionWhy(check({protection: rule({blocked_by_official_review_requests: true})}), 'main', [])).toBe('Waiting for requested official reviews.');
  expect(protectionWhy(check({protection: rule({blocked_by_outdated_branch: true})}), 'main', [])).toBe('The branch is behind main: update it first.');
  expect(protectionWhy(check({protection: rule({blocked_by_protected_files: true, changed_protected_files: ['go.mod']})}), 'main', [])).toBe('Changes protected files: go.mod.');
  expect(protectionWhy(check({protection: rule({required_checks: ['ci/*']})}), 'main', [{context: 'ci/a', state: 'pending'}])).toBe('Required checks have not passed: ci/*.');
  expect(protectionWhy(check({protection: rule({required_checks: ['ci/*']})}), 'main', [{context: 'ci/a', state: 'success'}])).toBeUndefined();
});

test('a run held for approval says so, and the runs list can show only those', () => {
  const held = {status: 'blocked', need_approval: true};
  const blocked = {status: 'blocked', need_approval: false};
  expect(awaitsApproval(held)).toBe(true);
  expect(awaitsApproval({status: 'success', need_approval: true})).toBe(false);
  expect(runLook(held)).toEqual({tone: 'warning', text: 'Needs approval'});
  expect(runLook(held, 'blocked')).toEqual({tone: 'warning', text: 'Needs approval'});
  expect(runLook(blocked).text).toBe('Blocked');
  expect(runMatches('approval', held)).toBe(true);
  expect(runMatches('approval', blocked)).toBe(false);
  expect(runMatches('running', held)).toBe(true);
});

const pr = (extra: Partial<PullRequest> = {}): PullRequest => ({
  id: 1, issue_id: 1, number: 33, status: 'conflict', head_repo_id: 2, base_repo_id: 1, head_branch: 'docs/readme', base_branch: 'main', merge_base: '',
  allow_maintainer_edit: true, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 1, conflicted_files: ['README.md', 'a b.txt'], flow: 0, ...extra,
});

test('conflict commands bring the base into the head branch, from a fork too', () => {
  expect(conflictCommands(pr(), {headRepo: 'bob/mobile', appURL: 'https://forge.example/'}).split('\n')).toEqual([
    'git fetch -u https://forge.example/bob/mobile.git docs/readme:bob-docs/readme',
    'git switch bob-docs/readme',
    'git fetch origin main',
    'git merge FETCH_HEAD',
    '# fix the conflicts, then',
    'git add README.md \'a b.txt\'',
    'git commit',
    'git push https://forge.example/bob/mobile.git bob-docs/readme:docs/readme',
  ]);
  expect(conflictCommands(pr({flow: 1, head_repo_id: 1}), {headRepo: 'acme/mobile', appURL: 'https://forge.example/'})).toContain('+refs/pull/33/head:pr-33');
});
