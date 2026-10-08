// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An intent's API v1 call (PLAN §4.8: writes go through the unchanged REST
// API, with an Idempotency-Key). Built when the intent is sent, from the
// freshest pool state: the repository's current name, the issue's current
// number, and for whole-set writes the set as it is now plus this intent.

import {untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import type {Intent} from './intents.ts';
import type {Overlay} from './overlay.ts';
import {membersAsOf} from './view.ts';

export interface ApiRequest {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /** Below /api/v1. */
  path: string;
  body?: unknown;
}

export class UnsendableIntent extends Error {
  override name = 'UnsendableIntent';
}

/** The API v1 request that carries out an intent, against the pool as it is now. */
export function requestFor(i: Intent, pool: Pool, overlay: Overlay): ApiRequest {
  return untracked(() => {
    const repo = pool.model('Repository').get(i.repoId)?.data;
    const issue = pool.model('Issue').get(i.issueId)?.data;
    if (!repo || !issue) throw new UnsendableIntent('the issue is not on this device any more');
    // "." and ".." would be resolved away by the URL parser (Forgejo refuses such names; never send one).
    if ([repo.owner_name, repo.name].some((n) => n === '.' || n === '..')) throw new UnsendableIntent('the repository name cannot be used in a request');
    const base = `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/issues/${String(issue.number)}`;
    switch (i.kind) {
      case 'issue.state':
        return {method: 'PATCH', path: base, body: {state: i.state}};
      case 'issue.milestone':
        // API v1: 0 clears the milestone.
        return {method: 'PATCH', path: base, body: {milestone: i.milestoneId}};
      case 'issue.label':
        // Adding an exclusive scoped label: Forgejo removes the scope's other labels itself.
        return i.add ?
          {method: 'POST', path: `${base}/labels`, body: {labels: [i.labelId]}} :
          {method: 'DELETE', path: `${base}/labels/${String(i.labelId)}`};
      case 'issue.assignee': {
        // API v1 only replaces the whole list (by login): the current set with this change (PLAN §5.4).
        const ids = membersAsOf(pool, overlay, 'IssueAssignee', i.issueId, i.id);
        const logins: string[] = [];
        for (const id of ids) {
          const login = pool.model('User').get(id)?.data.login;
          if (!login) throw new UnsendableIntent('an assignee’s profile is not on this device');
          logins.push(login);
        }
        return {method: 'PATCH', path: base, body: {assignees: logins.sort()}};
      }
    }
  });
}
