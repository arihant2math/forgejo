// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {proposalTarget} from './upstream.ts';

test('a fork\'s new branch is proposed to its upstream; a repository\'s own, to the branch it came from', () => {
  expect(proposalTarget('alice', 'atlas', 'main', 'fix', {owner: 'acme', name: 'atlas', defaultBranch: 'trunk'})).toEqual({
    to: {to: '/-/next/code/$owner/$repo/$', params: {owner: 'acme', repo: 'atlas', _splat: 'compare/trunk...alice:fix/-'}}, into: 'acme/atlas:trunk',
  });
  expect(proposalTarget('acme', 'atlas', 'dev', 'fix', undefined)).toEqual({
    to: {to: '/-/next/code/$owner/$repo/$', params: {owner: 'acme', repo: 'atlas', _splat: 'compare/dev...fix/-'}}, into: 'dev',
  });
});
