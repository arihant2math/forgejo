// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {shownTabs} from '../../ui/Code.tsx';
import {tabOfPath} from './repoPage.tsx';

describe('tabOfPath', () => {
  test('the home and every code view are the Code tab (GitHub keeps Code selected on them)', () => {
    for (const path of [
      '/acme/website',
      '/acme/website/',
      '/-/next/code/acme/website/-',
      '/-/next/code/acme/website/src/branch/main/-',
      '/-/next/code/acme/website/src/branch/main/README.md/-',
      '/-/next/code/acme/website/blame/branch/main/README.md/-',
      '/-/next/code/acme/website/commits/branch/main/-',
      '/-/next/code/acme/website/commit/0123456789abcdef0123456789abcdef01234567/-',
      '/-/next/code/acme/website/compare/main...small/-',
      '/-/next/code/acme/website/branches/-',
      '/-/next/code/acme/website/tags/-',
      '/-/next/code/acme/website/releases/-',
    ]) expect(tabOfPath(path), path).toBe('code');
  });

  test('issues, pull requests, Actions, the wiki and the activity are their own tabs', () => {
    expect(tabOfPath('/acme/website/wiki')).toBe('wiki');
    expect(tabOfPath('/acme/website/wiki/Home/-/edit')).toBe('wiki');
    expect(tabOfPath('/acme/website/issues')).toBe('issues');
    expect(tabOfPath('/acme/website/pulls')).toBe('pulls');
    expect(tabOfPath('/-/next/code/acme/website/actions/-')).toBe('actions');
    expect(tabOfPath('/-/next/code/acme/website/actions/runs/4/-')).toBe('actions');
    expect(tabOfPath('/acme/website/settings')).toBe('settings');
    expect(tabOfPath('/acme/website/settings/hooks')).toBe('settings');
    for (const path of ['/acme/website/activity', '/acme/website/activity/monthly', '/acme/website/activity/contributors']) expect(tabOfPath(path), path).toBe('activity');
    // Labels and milestones belong to Issues (GitHub's).
    for (const p of ['/acme/website/labels', '/acme/website/milestones', '/acme/website/milestone/3', '/acme/website/milestones/new']) expect(tabOfPath(p), p).toBe('issues');
  });

  test('anything else is no tab', () => {
    expect(tabOfPath('/acme')).toBeUndefined();
    expect(tabOfPath('/')).toBeUndefined();
    expect(tabOfPath('/acme/website/forks')).toBeUndefined();
    expect(tabOfPath('/-/next/code/acme/website/nonsense/-')).toBeUndefined();
    expect(tabOfPath('/-/next/acme/website/settings')).toBeUndefined();
    expect(tabOfPath('/-/next/projects/3')).toBeUndefined();
  });
});

describe('shownTabs (a tab bar\'s overflow into More)', () => {
  test('all fit: undefined (every tab in the bar)', () => {
    expect(shownTabs([50, 60, 70], 400, 4, 60)).toBeUndefined();
    expect(shownTabs([50, 60, 70], 400, 4, 60, 2)).toBeUndefined();
  });

  test('the tabs that do not fit beside the menu go into it', () => {
    // 60 (More) + 54 + 64 = 178 ≤ 200; + 74 > 200.
    expect(shownTabs([50, 60, 70], 200, 4, 60)).toEqual([0, 1]);
    expect(shownTabs([50, 60, 70], 100, 4, 60)).toEqual([]);
    // The current tab among those that fit: the same.
    expect(shownTabs([50, 60, 70], 200, 4, 60, 1)).toEqual([0, 1]);
  });

  test('the current tab stays in the bar, in place of the last ones that would fit', () => {
    // 60 + 74 (current, index 2) + 54 = 188 ≤ 200; + 64 > 200: the first tab and the current one.
    expect(shownTabs([50, 60, 70], 200, 4, 60, 2)).toEqual([0, 2]);
    // A wide current tab displaces every other one.
    expect(shownTabs([50, 60, 120], 200, 4, 60, 2)).toEqual([2]);
    // Even when it does not fit beside the menu (the bar then scrolls).
    expect(shownTabs([50, 60, 200], 200, 4, 60, 2)).toEqual([2]);
    // A later tab never jumps ahead of a hidden earlier one.
    expect(shownTabs([50, 60, 30, 70], 200, 4, 60, 3)).toEqual([0, 3]);
  });

  test('a bar not laid out yet (no room, a width unknown or 0) shows every tab', () => {
    expect(shownTabs([50, 60], 0, 4, 60)).toBeUndefined();
    expect(shownTabs([50, undefined], 100, 4, 60)).toBeUndefined();
    expect(shownTabs([50, 0], 100, 4, 60, 1)).toBeUndefined();
  });
});
