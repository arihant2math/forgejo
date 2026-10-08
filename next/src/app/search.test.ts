// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {issueListSearch, myListSearch, parseLabels} from './search.ts';

describe('list search params', () => {
  test('classic query strings parse; junk is dropped', () => {
    expect(issueListSearch({state: 'closed', labels: '3,-4,x,3', milestone: '-1', assignee: '7', poster: '0', sort: 'recentupdate', group: 'status', q: ' a '}))
      .toEqual({state: 'closed', labels: '3,-4', milestone: -1, assignee: 7, sort: 'recentupdate', group: 'status', q: ' a '});
    expect(issueListSearch({state: 'weird', labels: '', milestone: 'x', sort: 'random', group: 'labels', q: '   '})).toEqual({});
    expect(issueListSearch({labels: 5, assignee: 3})).toEqual({labels: '5', assignee: 3});
    expect(myListSearch({type: 'review_requested', state: 'all'})).toEqual({type: 'review_requested', state: 'all'});
    expect(parseLabels('3,-4')).toEqual([3, -4]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});
