// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The edits the issue UI makes (S/L/A/M/P, the context menu, the palette),
// on one issue or a selection: each becomes one intent per issue
// (intents/), applied to the overlay at once. Reads are untracked (these run
// in event handlers).

import {untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueLabelIds, issueMilestone, issueState} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {exclusiveScope} from './labels.ts';

function pool(app: App): Pool {
  const s = app.session;
  if (!s) throw new Error('no session');
  return s.data.pool;
}

/** The issues of these ids that are on this device. */
export function issuesOf(app: App, ids: readonly number[]): Entity<'Issue'>[] {
  const store = pool(app).model('Issue');
  return untracked(() => ids.map((id) => store.get(id)).filter((e): e is Entity<'Issue'> => e !== undefined));
}

/** The one repository all the issues are in, or undefined (none, or several). */
export function commonRepo(issues: readonly Entity<'Issue'>[]): number | undefined {
  const repos = new Set(untracked(() => issues.map((i) => i.data.repo_id)));
  return repos.size === 1 ? [...repos][0] : undefined;
}

export function setState(app: App, issues: readonly Entity<'Issue'>[], state: 'open' | 'closed'): void {
  const {intents, overlay} = editing(app);
  untracked(() => {
    for (const i of issues) {
      const base = issueState(overlay, i);
      if (base === state) continue;
      intents.submit({kind: 'issue.state', issueId: i.id, repoId: i.data.repo_id, state, base});
    }
  });
}

/** Adds a label to the issues missing it (an exclusive scoped label replaces its siblings), or removes it from all. */
export function setLabel(app: App, issues: readonly Entity<'Issue'>[], label: Label, add: boolean): void {
  const p = pool(app);
  const {intents, overlay} = editing(app);
  const scope = exclusiveScope(label);
  untracked(() => {
    for (const i of issues) {
      const current = issueLabelIds(p, overlay, i.id);
      if (current.includes(label.id) === add) continue;
      const drop = add && scope ? current.filter((id) => id !== label.id && exclusiveScope(p.model('Label').get(id)?.data ?? {name: '', exclusive: false}) === scope) : [];
      intents.submit({kind: 'issue.label', issueId: i.id, repoId: i.data.repo_id, labelId: label.id, add, drop});
    }
  });
}

/** Removes the issues' labels of an exclusive scope ("No priority"). */
export function clearScope(app: App, issues: readonly Entity<'Issue'>[], scope: string): void {
  const p = pool(app);
  const {overlay} = editing(app);
  untracked(() => {
    for (const i of issues) {
      for (const id of issueLabelIds(p, overlay, i.id)) {
        const l = p.model('Label').get(id)?.data;
        if (l && exclusiveScope(l) === scope) setLabel(app, [i], l, false);
      }
    }
  });
}

export function setAssignee(app: App, issues: readonly Entity<'Issue'>[], userId: number, add: boolean): void {
  const p = pool(app);
  const {intents, overlay} = editing(app);
  untracked(() => {
    for (const i of issues) {
      if (issueAssigneeIds(p, overlay, i.id).includes(userId) === add) continue;
      intents.submit({kind: 'issue.assignee', issueId: i.id, repoId: i.data.repo_id, userId, add});
    }
  });
}

export function setMilestone(app: App, issues: readonly Entity<'Issue'>[], milestoneId: number): void {
  const {intents, overlay} = editing(app);
  untracked(() => {
    for (const i of issues) {
      const base = issueMilestone(overlay, i);
      if (base === milestoneId) continue;
      intents.submit({kind: 'issue.milestone', issueId: i.id, repoId: i.data.repo_id, milestoneId, base});
    }
  });
}

/** The site path of an issue's page ("/owner/repo/issues/12"), if its repository is on this device. */
export function issuePath(app: App, issue: Entity<'Issue'>): string | undefined {
  return untracked(() => {
    const repo = pool(app).model('Repository').get(issue.data.repo_id)?.data;
    if (!repo) return undefined;
    return `/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/${issue.data.is_pull ? 'pulls' : 'issues'}/${String(issue.data.number)}`;
  });
}
