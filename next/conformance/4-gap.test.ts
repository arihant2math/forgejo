// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The gap endpoints (B9, /-/sync/api/): what API v1 lacks. Writes answer
// with the sync-id echo and their effect arrives as deltas (never in the
// response); conflict-checked body edits answer 409 with the current text;
// SHA-addressed git reads are immutable (ETag = SHA, 304) and refuse
// anything but a full SHA.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import type {
  APIBlame, APIBodyConflict, APIBodyEdited, APICreated, APIMarkdownResponse, APITree, APIViewedFiles, IssueBody, Project,
  ProjectColumn, ProjectIssue, ReviewState,
} from '../src/protocol/types.gen.ts';
import {type Account, type Repo, WebSession, api, createIssue, createRepo, createUser, eventually, request, syncId, unique} from './forgejo.ts';
import {load} from './replica.ts';
import {type Session, connect} from './sync.ts';

const open: Session[] = [];
afterAll(() => {
  for (const s of open) {
    s.close();
    expect(s.violations).toEqual([]);
  }
});

const gap = (method: string, path: string, who: Account, body?: unknown, key?: string) =>
  request(method, `/-/sync/api${path}`, {token: who.token, ...(body === undefined ? {} : {body}), ...(key ? {key} : {})});

describe('gap endpoints', () => {
  let alice: Account;
  let bob: Account;
  let repo: Repo;
  let s: Session;
  let head: string;

  beforeAll(async () => {
    alice = await createUser('alice');
    bob = await createUser('bob');
    repo = await createRepo(alice, {init: true});
    head = (await api<{commit: {id: string}}>('GET', `/repos/${repo.full}/branches/main`, {token: alice.token})).commit.id;
    const c = await connect('ws', alice.token, [{group: repo.group}, {group: `user:${alice.id}`}]);
    s = c.s;
    open.push(s);
    await s.next('caught_up');
  });

  test('conflict-checked body edit: echo + delta; a stale version gets 409 with the current text', async () => {
    const issue = await createIssue(alice, repo, 'with a body', 'version one');
    const group = `issue:${issue.id}`;
    await s.subscribeCaughtUp([{group}]);
    const body = (await load(alice.token, group, {path: 'load'})).changes.find((c) => c.m === 'IssueBody')?.d as IssueBody;
    const from = s.mark;
    const res = await gap('PATCH', `/issues/${issue.id}/body`, alice, {body: 'version **two**', expected_version: body.content_version});
    expect(res.status).toBe(200);
    const edited = await res.json() as APIBodyEdited;
    expect(edited.content_version).toBe(body.content_version + 1);
    const echo = syncId(res) ?? 0;
    const c = await s.change((x) => x.m === 'IssueBody' && x.id === issue.id, {from});
    expect(c.v).toBeLessThanOrEqual(echo);
    expect((c.d as IssueBody).body_html).toContain('<strong>two</strong>');

    const stale = await gap('PATCH', `/issues/${issue.id}/body`, alice, {body: 'lost update', expected_version: body.content_version});
    expect(stale.status).toBe(409);
    expect(await stale.json() as APIBodyConflict).toMatchObject({body: 'version **two**', content_version: edited.content_version});

    // Readable but not changeable by bob; keyed edits are replayed.
    expect((await gap('PATCH', `/issues/${issue.id}/body`, bob, {body: 'x', expected_version: edited.content_version})).status).toBe(403);
    const key = unique('key');
    const k1 = await gap('PATCH', `/issues/${issue.id}/body`, alice, {body: 'three', expected_version: edited.content_version}, key);
    const k2 = await gap('PATCH', `/issues/${issue.id}/body`, alice, {body: 'three', expected_version: edited.content_version}, key);
    expect([k1.status, k2.status]).toEqual([200, 200]);
    expect(k2.headers.get('X-Livesync-Idempotent-Replay')).toBe('true');
    expect(await k2.text()).toBe(await k1.text());
  });

  test('project board: columns and card moves through the gap endpoints arrive as deltas', async () => {
    // API v1 has no projects: create one and put an issue on it like the classic UI does.
    const web = await WebSession.signIn(alice);
    const title = unique('board');
    let from = s.mark;
    const created = await web.form(`/${repo.full}/projects/new`, {title, content: '', template_type: 'basic_kanban', card_type: 'text_only'});
    expect(created.status).toBe(303);
    const project = await s.change((c) => c.m === 'Project' && (c.d as Project).title === title, {from});
    const columns = await eventually('the template columns', () => {
      const cols = s.changes((c) => c.m === 'ProjectColumn' && (c.d as ProjectColumn).project_id === project.id, from);
      return cols.length >= 4 ? cols : undefined;
    });
    const issue = await createIssue(alice, repo, 'a card');
    from = s.mark;
    const put = await web.form(`/${repo.full}/issues/projects`, {issue_ids: String(issue.id), id: String(project.id)});
    expect(put.status).toBe(200);
    await s.change((c) => c.m === 'ProjectIssue' && (c.d as ProjectIssue).issue_id === issue.id, {from});

    // A new column: 201 {id} + echo; the column itself comes as a delta.
    from = s.mark;
    const res = await gap('POST', `/projects/${project.id}/columns`, alice, {title: 'Review', color: '#aabbcc'});
    expect(res.status).toBe(201);
    const col = await res.json() as APICreated;
    const colChange = await s.change((c) => c.m === 'ProjectColumn' && c.id === col.id, {from});
    expect(colChange.v).toBeLessThanOrEqual(syncId(res) ?? 0);
    expect(colChange.d).toMatchObject({title: 'Review', color: '#aabbcc', project_id: project.id});

    // Move the card there.
    from = s.mark;
    const move = await gap('POST', `/projects/${project.id}/columns/${col.id}/cards`, alice, {issue_id: issue.id, position: 0});
    expect(move.status).toBe(204);
    const card = await s.change((c) => c.m === 'ProjectIssue' && (c.d as ProjectIssue).issue_id === issue.id, {from});
    expect((card.d as ProjectIssue).column_id).toBe(col.id);
    expect(card.v).toBeLessThanOrEqual(syncId(move) ?? 0);

    // Reorder every column; an incomplete order is stale (409).
    const ids = [...columns.map((c) => c.id), col.id].reverse();
    expect((await gap('PUT', `/projects/${project.id}/column-order`, alice, {column_ids: ids})).status).toBe(204);
    expect((await gap('PUT', `/projects/${project.id}/column-order`, alice, {column_ids: ids.slice(1)})).status).toBe(409);

    // Not bob's board; keyed creates run once.
    expect((await gap('POST', `/projects/${project.id}/columns`, bob, {title: 'nope'})).status).toBe(403);
    const key = unique('key');
    const a = await gap('POST', `/projects/${project.id}/columns`, alice, {title: 'Once'}, key);
    const b = await gap('POST', `/projects/${project.id}/columns`, alice, {title: 'Once'}, key);
    expect(b.headers.get('X-Livesync-Idempotent-Replay')).toBe('true');
    expect((await b.json() as APICreated).id).toBe((await a.json() as APICreated).id);
  });

  test('viewed files of a pull request: state + ReviewState delta in the viewer\'s own group', async () => {
    await api('POST', `/repos/${repo.full}/contents/feature.txt`, {
      token: alice.token, body: {content: btoa('a feature\n'), message: 'feature', branch: 'main', new_branch: 'feature'},
    });
    const pr = await api<{number: number; head: {sha: string}}>('POST', `/repos/${repo.full}/pulls`, {token: alice.token, body: {head: 'feature', base: 'main', title: 'a pull'}});
    const issueId = (await api<{id: number}>('GET', `/repos/${repo.full}/issues/${pr.number}`, {token: alice.token})).id;
    const from = s.mark;
    const res = await gap('PUT', `/issues/${issueId}/viewed`, alice, {commit_sha: pr.head.sha, files: {'feature.txt': true}});
    expect(res.status).toBe(200);
    const state = await res.json() as APIViewedFiles;
    expect(state.files).toEqual({'feature.txt': 'viewed'});
    const c = await s.change((x) => x.m === 'ReviewState', {from});
    expect(c.g).toBe(`user:${alice.id}`);
    expect(Object.keys((c.d as ReviewState).updated_files)).toEqual(['feature.txt']);
    expect(c.v).toBeLessThanOrEqual(syncId(res) ?? 0);
    const got = await (await gap('GET', `/issues/${issueId}/viewed`, alice)).json() as APIViewedFiles;
    expect(got.files).toEqual({'feature.txt': 'viewed'});
    // The state is per viewer: bob (a reader) has his own, alice hears nothing of it.
    const mine = s.mark;
    const theirs = await gap('PUT', `/issues/${issueId}/viewed`, bob, {commit_sha: pr.head.sha, files: {'feature.txt': false}});
    expect((await theirs.json() as APIViewedFiles).files).toEqual({'feature.txt': 'unviewed'});
    expect((await (await gap('GET', `/issues/${issueId}/viewed`, alice)).json() as APIViewedFiles).files).toEqual({'feature.txt': 'viewed'});
    await s.barrier();
    expect(s.changes((x) => x.m === 'ReviewState', mine)).toEqual([]);
  });

  test('immutable SHA-addressed reads: tree, raw, blob, blame, diff', async () => {
    const tree = await gap('GET', `/repos/${repo.id}/tree/${head}`, alice);
    expect(tree.status).toBe(200);
    expect(tree.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    const t = await tree.json() as APITree;
    expect(tree.headers.get('ETag')).toBe(`"${t.sha}"`);
    const readme = t.entries.find((e) => e.name === 'README.md');
    expect(readme?.type).toBe('blob');
    expect((await request('GET', `/-/sync/api/repos/${repo.id}/tree/${head}`, {token: alice.token, headers: {'If-None-Match': `"${t.sha}"`}})).status).toBe(304);

    const expected = await (await request('GET', `/api/v1/repos/${repo.full}/raw/README.md?ref=${head}`, {token: alice.token})).text();
    const raw = await gap('GET', `/repos/${repo.id}/raw/${head}/README.md`, alice);
    expect(raw.headers.get('ETag')).toBe(`"${readme?.sha}"`);
    expect(raw.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await raw.text()).toBe(expected);
    expect(await (await gap('GET', `/repos/${repo.id}/blobs/${readme?.sha}`, alice)).text()).toBe(expected);

    const blame = await (await gap('GET', `/repos/${repo.id}/blame/${head}/README.md`, alice)).json() as APIBlame;
    expect(blame.parts.map((p) => p.sha)).toEqual([head]);
    expect(blame.commits[head]?.author_name).not.toBe('');

    const diff = await gap('GET', `/repos/${repo.id}/diff/${head}`, alice);
    expect(diff.headers.get('ETag')).toBe(`"${head}"`);
    expect(await diff.text()).toContain('+++ b/README.md');

    // Only full SHAs address content; no access, no content (and no difference).
    expect((await gap('GET', `/repos/${repo.id}/tree/main`, alice)).status).toBe(404);
    expect((await gap('GET', `/repos/${repo.id}/tree/${head.slice(0, 10)}`, alice)).status).toBe(404);
    const secret = await createRepo(alice, {private: true, init: true});
    const secretHead = (await api<{commit: {id: string}}>('GET', `/repos/${secret.full}/branches/main`, {token: alice.token})).commit.id;
    expect((await gap('GET', `/repos/${secret.id}/tree/${secretHead}`, bob)).status).toBe(404);
    expect((await gap('GET', `/repos/999999999/tree/${secretHead}`, bob)).status).toBe(404);
  });

  test('batch markdown preview = the HTML the sync log carries', async () => {
    const res = await gap('POST', '/markdown', alice, {repo_id: repo.id, items: ['**bold**', 'plain']});
    expect(res.status).toBe(200);
    const out = await res.json() as APIMarkdownResponse;
    expect(out.html).toHaveLength(2);
    expect(out.html[0]).toContain('<strong>bold</strong>');
    const issue = await createIssue(alice, repo, 'rendered', '**bold**');
    const body = (await load(alice.token, `issue:${issue.id}`, {path: 'load'})).changes.find((c) => c.m === 'IssueBody')?.d as IssueBody;
    expect(body.body_html).toBe(out.html[0]);
  });
});
