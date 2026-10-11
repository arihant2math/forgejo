// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {proposalTarget} from './upstream.ts';

test('a fork\'s new branch is proposed to its upstream; a repository\'s own, to the branch it came from', () => {
  expect(proposalTarget('alice', 'atlas', 'main', 'fix', {owner: 'acme', name: 'atlas', defaultBranch: 'trunk'})).toEqual({
    to: {to: '/$owner/$repo/$view/$', params: {owner: 'acme', repo: 'atlas', view: 'compare', _splat: 'trunk...alice:fix'}}, into: 'acme/atlas:trunk',
  });
  expect(proposalTarget('acme', 'atlas', 'dev', 'fix', undefined)).toEqual({
    to: {to: '/$owner/$repo/$view/$', params: {owner: 'acme', repo: 'atlas', view: 'compare', _splat: 'dev...fix'}}, into: 'dev',
  });
});
