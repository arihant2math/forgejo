// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {feedDays, feedEntry, type FeedAction} from './feed.ts';

const action: FeedAction = {id: 1, op_type: 'create_issue', act_user: {login: 'alice'}, repo: {id: 2, full_name: 'team/project'}, content: '["12","A title"]', ref_name: '', created: '2026-10-11T12:00:00Z'};

describe('dashboard feed', () => {
  it('links issues, pull requests, comments and legacy content into the app', () => {
    expect(feedEntry(action)).toEqual({path: '/team/project/issues/12', text: 'alice opened an issue in team/project #12 — A title'});
    expect(feedEntry({...action, op_type: 'merge_pull_request'}).path).toBe('/team/project/pulls/12');
    expect(feedEntry({...action, op_type: 'comment_issue', content: '12|a comment'}).path).toBe('/team/project/issues/12');
    expect(feedEntry({...action, content: '{broken'}).path).toBe('/team/project');
  });
  it('links pushes by immutable SHA and releases to the app releases page', () => {
    const sha = 'a'.repeat(40);
    expect(feedEntry({...action, op_type: 'commit_repo', content: JSON.stringify({Commits: [{Sha1: sha}]})}).path).toBe(`/team/project/commit/${sha}`);
    expect(feedEntry({...action, op_type: 'publish_release'}).path).toBe('/team/project/releases');
    expect(feedEntry({...action, op_type: 'commit_repo', content: '{"Commits":[{"Sha1":"../../evil"}]}'}).path).toBe('/team/project');
  });
  it('groups days while preserving server order', () => {
    const days = feedDays([action, {...action, id: 2}, {...action, id: 3, created: '2026-10-09T12:00:00Z'}]);
    expect(days.map(([, rows]) => rows.map((r) => r.id))).toEqual([[1, 2], [3]]);
  });
});
