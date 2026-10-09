// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {parseThread} from './subject.ts';

test('a notification thread names its issue or pull request', () => {
  expect(parseThread({
    subject: {title: 'Try out the merge queue?', url: 'http://h/api/v1/repos/bob/sandbox/issues/1', type: 'Issue', state: 'open'},
    repository: {name: 'sandbox', owner: {login: 'bob'}},
  })).toEqual({title: 'Try out the merge queue?', owner: 'bob', repo: 'sandbox', number: 1, pull: false, state: 'open'});
  expect(parseThread({subject: {title: 'x', url: 'http://h/api/v1/repos/a/b/pulls/7', type: 'Pull', state: 'merged'}, repository: {name: 'b', owner: {login: 'a'}}}))
    .toMatchObject({number: 7, pull: true, state: 'merged'});
  expect(parseThread({subject: {title: 'a commit', url: 'http://h/api/v1/repos/a/b/commits/abc', type: 'Commit'}, repository: {name: 'b', owner: {login: 'a'}}})).toBeUndefined();
  expect(parseThread(undefined)).toBeUndefined();
});
