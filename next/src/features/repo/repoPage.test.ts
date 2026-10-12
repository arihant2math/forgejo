// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UnderlineNav} from '@primer/react';
import {tabOfPath} from './repoPage.tsx';

describe('tabOfPath', () => {
  test('the home and every code view are the Code tab (GitHub keeps Code selected on them)', () => {
    for (const path of [
      '/acme/website',
      '/acme/website/',
      '/acme/website',
      '/acme/website/src/branch/main',
      '/acme/website/src/branch/main/README.md',
      '/acme/website/blame/branch/main/README.md',
      '/acme/website/commits/branch/main',
      '/acme/website/commit/0123456789abcdef0123456789abcdef01234567',
      '/acme/website/compare/main...small',
      '/acme/website/branches',
      '/acme/website/tags',
      '/acme/website/releases',
    ]) expect(tabOfPath(path), path).toBe('code');
  });

  test('issues, pull requests, Actions, the wiki and the activity are their own tabs', () => {
    expect(tabOfPath('/acme/website/wiki')).toBe('wiki');
    expect(tabOfPath('/acme/website/wiki/Home/-/edit')).toBe('wiki');
    expect(tabOfPath('/acme/website/issues')).toBe('issues');
    expect(tabOfPath('/acme/website/pulls')).toBe('pulls');
    expect(tabOfPath('/acme/website/actions')).toBe('actions');
    expect(tabOfPath('/acme/website/actions/runs/4')).toBe('actions');
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
    expect(tabOfPath('/acme/website/nonsense')).toBeUndefined();
    expect(tabOfPath('/-/next/acme/website/settings')).toBeUndefined();
    expect(tabOfPath('/-/next/projects/3')).toBeUndefined();
  });
});

describe('Primer repository navigation (overflow is handled by Primer)', () => {
  const open = (current?: number) => {
    return renderToStaticMarkup(createElement(UnderlineNav, {
      'aria-label': 'Sections',
      children: ['Code', 'Issues', 'Wiki'].map((name, i) => createElement(UnderlineNav.Item, {key: name, href: '/' + name, 'aria-current': i === current ? 'page' : false}, name)),
    }));
  };
  test('all fit: every tab is a link', () => {
    expect(open().match(/<a /g)).toHaveLength(3);
  });
  test('all destinations are supplied to Primer for overflow navigation', () => {
    const nav = open();
    for (const name of ['Code', 'Issues', 'Wiki']) expect(nav).toContain(`href="/${name}"`);
  });
  test('the current tab stays in the bar in document order', () => {
    const nav = open(2);
    expect(nav).toContain('aria-current="page"');
    expect(nav.indexOf('href="/Code"')).toBeLessThan(nav.indexOf('href="/Wiki"'));
  });
  test('a bar not laid out yet shows every tab', () => {
    expect(open().match(/href="\//g)).toHaveLength(3);
  });
});
