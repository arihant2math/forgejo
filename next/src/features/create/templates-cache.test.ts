// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';
import {createApp} from '../../app/store.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {loadTemplates} from './templates.ts';

const cache = vi.hoisted(() => new Map<string, unknown>());
const request = vi.hoisted(() => vi.fn());
vi.mock('../../code/source.ts', () => ({codeSource: () => ({cache: {get: (key: string) => Promise.resolve(cache.get(key)), put: (key: string, value: unknown) => { cache.set(key, value); }}})}));
vi.mock('../../app/api.ts', () => ({online: request}));

afterEach(() => { vi.unstubAllGlobals(); cache.clear(); request.mockReset(); });

function app() {
  const s = fakeSession();
  s.data.put('Repository', 'repo:20', repo(20, user(1, 'alice'), 'website'));
  return createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
}

test('templates are cached by repository and default-branch SHA, reused after restart offline', async () => {
  vi.stubGlobal('navigator', {onLine: true});
  request.mockImplementation((_app, req: {path: string}) => Promise.resolve(req.path.includes('/branches/') ? {commit: {id: 'abc123'}} : req.path.endsWith('/issue_config') ? {blank_issues_enabled: false, contact_links: []} : req.path.endsWith('/assignees') ? [] : [{name: 'Bug', file_name: 'bug.md'}]));
  const online = app();
  const [first, prefetched] = await Promise.all([loadTemplates(online, 20), loadTemplates(online, 20)]);
  expect(prefetched).toEqual(first);
  expect(request).toHaveBeenCalledTimes(4);
  expect(cache.get('issue-templates:20:latest')).toBe('issue-templates:20:abc123');
  vi.stubGlobal('navigator', {onLine: false});
  expect(await loadTemplates(app(), 20)).toEqual(first);
  expect(request).toHaveBeenCalledTimes(4);
});

test('offline without a cached template set offers a blank issue and a note', async () => {
  vi.stubGlobal('navigator', {onLine: false});
  const result = await loadTemplates(app(), 20);
  expect(result.config.blank_issues_enabled).toBe(true);
  expect(result.templates).toEqual([]);
  expect(result.note).toContain('offline');
  expect(request).not.toHaveBeenCalled();
});
