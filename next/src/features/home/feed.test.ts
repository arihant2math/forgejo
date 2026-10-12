// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {commentPreview, feedDays, feedEntry, type FeedAction} from './feed.ts';

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
  it('names the branch or tag of ref actions and links to it or its list', () => {
    const ref = (op_type: string, ref_name: string) => feedEntry({...action, op_type, ref_name, content: ''});
    expect(ref('delete_branch', 'refs/heads/fix/foo')).toEqual({path: '/team/project/branches', text: 'alice deleted branch fix/foo in team/project'});
    expect(ref('push_tag', 'refs/tags/v1.0.0')).toEqual({path: '/team/project/src/tag/v1.0.0', text: 'alice created tag v1.0.0 in team/project'});
    expect(ref('push_tag', 'refs/tags/release/a b')).toEqual({path: '/team/project/src/tag/release/a%20b', text: 'alice created tag release/a b in team/project'});
    expect(ref('delete_tag', 'refs/tags/v0.9')).toEqual({path: '/team/project/tags', text: 'alice deleted tag v0.9 in team/project'});
    expect(ref('mirror_sync_create', 'refs/heads/main').path).toBe('/team/project/src/branch/main');
    expect(ref('mirror_sync_delete', 'refs/tags/v2').text).toBe('alice removed tag v2 in team/project');
    expect(ref('delete_branch', 'old').text).toBe('alice deleted branch old in team/project');
    expect(ref('delete_tag', '')).toEqual({path: '/team/project', text: 'alice deleted a tag in team/project'});
  });
  it('previews comments as plain text, past a leading quote, and opens the comment', () => {
    const quoted = '> Accept-based negotiation breaks caching.\n\nExtensions are **simpler**, agreed.';
    expect(feedEntry({...action, op_type: 'comment_issue', content: '["85","> Accept-based negotiation breaks caching."]', comment_id: 1768, comment: {id: 1768, body: quoted}}))
      .toEqual({path: '/team/project/issues/85#comment-1768', text: 'alice commented in team/project #85 — Extensions are simpler, agreed.'});
    expect(feedEntry({...action, op_type: 'comment_pull', content: '["9","> +1 to dev"]'}))
      .toEqual({path: '/team/project/pulls/9', text: 'alice commented on a pull request in team/project #9 — +1 to dev'});
    expect(feedEntry({...action, content: '["3","> not a quote"]'}).text).toBe('alice opened an issue in team/project #3 — > not a quote');
  });
  it('commentPreview skips quotes, fences and markup', () => {
    expect(commentPreview('> > nested quote only')).toBe('nested quote only');
    expect(commentPreview('```\ncode\n```\n- [x] done [docs](http://x) `ok`')).toBe('done docs ok');
    expect(commentPreview('')).toBe('');
    expect(commentPreview('x'.repeat(300)).length).toBe(200);
  });
  it('groups days while preserving server order', () => {
    const days = feedDays([action, {...action, id: 2}, {...action, id: 3, created: '2026-10-09T12:00:00Z'}]);
    expect(days.map(([, rows]) => rows.map((r) => r.id))).toEqual([[1, 2], [3]]);
  });
});
