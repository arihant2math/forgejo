// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An intent's API call (PLAN §4.8: writes go through the unchanged REST API
// v1, or a livesync gap endpoint (B9) where API v1 lacks one, always with an
// Idempotency-Key). Built when the intent is first sent, from the freshest
// pool state — the repository's current name, the issue's current number,
// for whole-set writes the set as it is now plus this intent — and then
// frozen with its key (executor.ts): every retry must be the same request
// (B7 answers 422 to the same key with another body).

import {untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import {type Intent, isTemp} from './intents.ts';
import type {Overlay} from './overlay.ts';
import {membersAsOf} from './view.ts';

export interface ApiRequest {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** Below the API's base: API v1 (`/api/v1`) or livesync's gap endpoints (`/-/sync/api`, B9). */
  api: 'v1' | 'sync';
  path: string;
  body?: unknown;
}

/** The intent cannot be sent as it is (its target is gone): it fails, its text is kept as a draft. */
export class UnsendableIntent extends Error {
  override name = 'UnsendableIntent';
}

/** The intent cannot be sent yet (its repository or issue is not in the pool yet): it waits. */
export class NotReady extends Error {
  override name = 'NotReady';
}

/** The API request that carries out an intent, against the pool as it is now. */
export function requestFor(i: Intent, pool: Pool, overlay: Overlay): ApiRequest {
  return untracked(() => {
    for (const id of [i.issueId, ...('commentId' in i ? [i.commentId] : [])]) {
      if (isTemp(id) && !(i.kind === 'issue.create' && id === i.issueId)) throw new NotReady('waiting for an entity created offline');
    }
    if (i.kind === 'notification.status') {
      return {method: 'PATCH', api: 'v1', path: `/notifications/threads/${String(i.notificationId)}?to-status=${i.status}`};
    }
    const repo = pool.model('Repository').get(i.repoId)?.data;
    if (!repo) throw new NotReady('the repository is not on this device yet');
    // "." and ".." would be resolved away by the URL parser (Forgejo refuses such names; never send one).
    if ([repo.owner_name, repo.name].some((n) => n === '.' || n === '..')) throw new UnsendableIntent('the repository name cannot be used in a request');
    const repoPath = `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}`;
    if (i.kind === 'issue.create') {
      const logins = i.assigneeIds.map((u) => login(pool, u));
      return {method: 'POST', api: 'v1', path: `${repoPath}/issues`, body: {
        title: i.title, body: i.body, labels: i.labelIds, ...(logins.length ? {assignees: logins} : {}), ...(i.milestoneId ? {milestone: i.milestoneId} : {}),
      }};
    }
    // Comments by id need no issue number.
    switch (i.kind) {
      case 'comment.edit':
        return {method: 'PATCH', api: 'sync', path: `/comments/${String(i.commentId)}/body`, body: {body: i.text, expected_version: i.baseVersion}};
      case 'comment.delete':
        return {method: 'DELETE', api: 'v1', path: `${repoPath}/issues/comments/${String(i.commentId)}`};
      case 'reaction':
        if (i.commentId) return {method: i.add ? 'POST' : 'DELETE', api: 'v1', path: `${repoPath}/issues/comments/${String(i.commentId)}/reactions`, body: {content: i.content}};
        break;
      case 'issue.body':
        return {method: 'PATCH', api: 'sync', path: `/issues/${String(i.issueId)}/body`, body: {body: i.text, expected_version: i.baseVersion}};
      case 'board.move':
        return {method: 'POST', api: 'sync', path: `/projects/${String(i.projectId)}/columns/${String(i.columnId)}/cards`, body: {issue_id: i.issueId, position: i.position}};
      case 'pr.viewed':
        return {method: 'PUT', api: 'sync', path: `/issues/${String(i.issueId)}/viewed`, body: {commit_sha: i.commitSha, files: i.files}};
      default:
        break;
    }
    const issue = pool.model('Issue').get(i.issueId)?.data;
    if (!issue) throw new NotReady('the issue is not on this device yet');
    const base = `${repoPath}/issues/${String(issue.number)}`;
    switch (i.kind) {
      case 'issue.state':
        return {method: 'PATCH', api: 'v1', path: base, body: {state: i.state}};
      case 'issue.title':
        return {method: 'PATCH', api: 'v1', path: base, body: {title: i.title}};
      case 'issue.deadline':
        return {method: 'PATCH', api: 'v1', path: base, body: i.due === null ? {unset_due_date: true} : {due_date: `${i.due}T00:00:00Z`}};
      case 'issue.milestone':
        // API v1: 0 clears the milestone.
        return {method: 'PATCH', api: 'v1', path: base, body: {milestone: i.milestoneId}};
      case 'issue.pin':
        return {method: i.pinned ? 'POST' : 'DELETE', api: 'v1', path: `${base}/pin`};
      case 'issue.lock':
        return i.locked ? {method: 'PUT', api: 'v1', path: `${base}/lock`, body: {reason: i.reason}} : {method: 'DELETE', api: 'v1', path: `${base}/lock`};
      case 'issue.label':
        // Adding an exclusive scoped label: Forgejo removes the scope's other labels itself.
        return i.add ?
          {method: 'POST', api: 'v1', path: `${base}/labels`, body: {labels: [i.labelId]}} :
          {method: 'DELETE', api: 'v1', path: `${base}/labels/${String(i.labelId)}`};
      case 'issue.assignee': {
        // API v1 only replaces the whole list (by login): the current set with this change (PLAN §5.4).
        const ids = membersAsOf(pool, overlay, 'IssueAssignee', i.issueId, i.id) as Set<number>;
        return {method: 'PATCH', api: 'v1', path: base, body: {assignees: [...ids].map((u) => login(pool, u)).sort()}};
      }
      case 'issue.dependency': {
        const dep = pool.model('Issue').get(i.dependencyId)?.data;
        const depRepo = dep ? pool.model('Repository').get(dep.repo_id)?.data : undefined;
        if (!dep || !depRepo) throw new NotReady('the other issue is not on this device yet');
        return {method: i.add ? 'POST' : 'DELETE', api: 'v1', path: `${base}/dependencies`, body: {index: dep.number, owner: depRepo.owner_name, repo: depRepo.name}};
      }
      case 'issue.subscribe':
        return {method: i.add ? 'PUT' : 'DELETE', api: 'v1', path: `${base}/subscriptions/${encodeURIComponent(login(pool, i.userId))}`};
      case 'issue.reviewer':
        return {method: i.add ? 'POST' : 'DELETE', api: 'v1', path: `${repoPath}/pulls/${String(issue.number)}/requested_reviewers`, body: {reviewers: [login(pool, i.userId)]}};
      case 'reaction':
        return {method: i.add ? 'POST' : 'DELETE', api: 'v1', path: `${base}/reactions`, body: {content: i.content}};
      case 'comment.create':
        return {method: 'POST', api: 'v1', path: `${base}/comments`, body: {body: i.body}};
      case 'review.submit':
        return {method: 'POST', api: 'v1', path: `${repoPath}/pulls/${String(issue.number)}/reviews`, body: {
          commit_id: i.commitId, event: i.event, body: i.body,
          comments: i.comments.map((c) => ({path: c.path, body: c.body, new_position: c.newLine, old_position: c.oldLine})),
        }};
    }
    return unreachable(i);
  });
}

function unreachable(i: never): never {
  throw new UnsendableIntent(`no request for ${(i as Intent).kind}`);
}

function login(pool: Pool, userId: number): string {
  const l = pool.model('User').get(userId)?.data.login;
  if (!l) throw new NotReady('a user’s profile is not on this device yet');
  return l;
}
