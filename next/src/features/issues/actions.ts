// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {noun} from '../../app/words.ts';
import {runInAction, untracked} from 'mobx';
import {canWrite} from '../../app/access.ts';
import {classicHref} from '../../app/classic.ts';
import {sitePath} from '../../app/config.ts';
import {notify} from '../../app/notices.ts';
import type {ShortcutId} from '../../app/shortcuts/index.ts';
import type {App, PickerKind} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueLabelIds, issueState, viewMembers} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {repoLabels} from './candidates.ts';
import {issuePath, setAssignee, setLabel, setState} from './edits.ts';
import {exclusiveScope, kindRank, labelKind, scopedValue, statusStage, terminalStatus} from './labels.ts';
import {BrowserIcon, CheckCircleIcon, IssueDraftIcon, IssueOpenedIcon, CopyIcon, ReplyIcon, LinkExternalIcon, MilestoneIcon, GraphBarVerticalIcon, TagIcon, PersonIcon, PersonAddIcon, PeopleIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';

export interface IssueAction {
  id: string;
  label: string;
  icon: OcticonType;
  shortcut?: ShortcutId;
  keywords?: string;
  run(): void;
}

export function openPicker(app: App, kind: PickerKind, issueIds: readonly number[]): void {
  if (!issueIds.length) return;
  const s = app.session;
  const store = s?.data.pool.model('Issue');
  if (s && store && issueIds.some((id) => {
    const repoId = untracked(() => store.get(id)?.data.repo_id);
    return repoId !== undefined && !canWrite(s, repoId);
  })) {
    notify(app, {tone: 'neutral', title: 'Read-only', description: 'You can read this repository but not change its issues.'});
    return;
  }
  runInAction(() => {
    app.ui.picker = {kind, issueIds: [...issueIds]};
  });
}

/** State changes support Undo via a compensating intent, which cancels the change offline. */
export function changeState(app: App, issues: readonly Entity<'Issue'>[], state: 'open' | 'closed'): void {
  const wanted = untracked(() => {
    const {overlay} = editing(app);
    return issues.filter((i) => issueState(overlay, i) !== state);
  });
  // Forgejo refuses closing issues blocked by open dependencies; validate before applying.
  const changed = state === 'closed' ? withoutBlocked(app, wanted) : wanted;
  if (!changed.length) return;
  setState(app, changed, state);
  const one = changed.length === 1 ? changed[0] : undefined;
  const pull = untracked(() => changed.every((i) => i.data.is_pull));
  const what = one ? `#${String(untracked(() => one.data.number))}` : `${String(changed.length)} ${pull ? 'pull requests' : 'issues'}`;
  notify(app, {tone: 'neutral', series: 'state', title: `${state === 'closed' ? 'Closed' : 'Reopened'} ${what}`, action: {label: 'Undo', run: () => {
    setState(app, changed, state === 'closed' ? 'open' : 'closed');
  }}});
}

/** Done/canceled workflow statuses close issues; all other statuses reopen them. */
export function setWorkflowStatus(app: App, issues: readonly Entity<'Issue'>[], label: Label): void {
  const closes = terminalStatus(label.name);
  // Apply status and state atomically: blocked issues must retain both.
  const target = closes ? withoutBlocked(app, issues) : issues;
  if (!target.length) return;
  setLabel(app, target, label, true);
  changeState(app, target, closes ? 'closed' : 'open');
}

/** Only dependencies cached on this device can be checked. */
export function openBlockers(app: App, issue: Entity<'Issue'>): Entity<'Issue'>[] {
  const pool = app.session?.data.pool;
  if (!pool) return [];
  const {overlay} = editing(app);
  return untracked(() => [...viewMembers(pool, overlay, 'IssueDependency', issue.id)]
    .map((id) => pool.model('Issue').get(id as number))
    .filter((d): d is Entity<'Issue'> => d !== undefined && issueState(overlay, d) === 'open'));
}

function withoutBlocked(app: App, issues: readonly Entity<'Issue'>[]): Entity<'Issue'>[] {
  const blocked = issues.map((i) => [i, openBlockers(app, i)] as const).filter(([, b]) => b.length > 0);
  if (!blocked.length) return [...issues];
  const [first] = blocked;
  if (first) {
    const [issue, by] = first;
    const refs = by.slice(0, 3).map((d) => `#${String(untracked(() => d.data.number))}`).join(', ');
    notify(app, {
      tone: 'warning',
      title: blocked.length === 1 ? `#${String(untracked(() => issue.data.number))} cannot be closed yet` : `${String(blocked.length)} issues cannot be closed yet`,
      description: `It is blocked by ${refs}, still open. Close ${noun(by.length, 'it', 'them')} first, or remove the dependency.`,
    });
  }
  return issues.filter((i) => !blocked.some(([b]) => b === i));
}

/** Reopening resets a terminal workflow status to the first to-do status, or removes it if none exists. */
export function reopen(app: App, issues: readonly Entity<'Issue'>[]): void {
  const pool = app.session?.data.pool;
  if (!pool) return;
  const {overlay} = editing(app);
  untracked(() => {
    for (const i of issues) {
      const ids = issueLabelIds(pool, overlay, i.id);
      const terminal = ids.map((id) => pool.model('Label').get(id)?.data).find((l) => l && labelKind(l) === 'status' && terminalStatus(l.name));
      if (!terminal) continue;
      const todo = repoLabels(pool, i.data.repo_id).filter((l) => labelKind(l) === 'status' && exclusiveScope(l) === exclusiveScope(terminal))
        .sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name)).find((l) => statusStage(scopedValue(l.name)) === 'todo');
      if (todo) setLabel(app, [i], todo, true);
      else setLabel(app, [i], terminal, false);
    }
  });
  changeState(app, issues, 'open');
}

/** Read untracked when opening a menu. */
export function issueActions(app: App, issues: readonly Entity<'Issue'>[], opts: {navigate?: (path: string) => void} = {}): IssueAction[] {
  if (!issues.length) return [];
  const s = app.session;
  if (!s) return [];
  const ids = issues.map((i) => i.id);
  const {overlay} = editing(app);
  return untracked(() => {
    const allOpen = issues.every((i) => issueState(overlay, i) === 'open');
    const me = s.userId;
    const mine = issues.every((i) => issueAssigneeIds(s.data.pool, overlay, i.id).includes(me));
    const one = issues.length === 1 ? issues[0] : undefined;
    const path = one && issuePath(app, one);
    const pull = issues.every((i) => i.data.is_pull);
    const noun = issues.length > 1 ? `${String(issues.length)} ${pull ? 'pull requests' : 'issues'}` : '';
    const write = issues.every((i) => canWrite(s, i.data.repo_id));
    const closeable = write || issues.every((i) => i.data.poster_id === me);
    const out: IssueAction[] = [];
    if (path && opts.navigate) {
      const go = opts.navigate;
      out.push({id: 'open', label: 'Open', icon: ReplyIcon, run: () => {
        go(path);
      }});
    }
    if (closeable) {
      out.push({id: 'state', label: allOpen ? `Close${noun ? ` ${noun}` : ''}` : `Reopen${noun ? ` ${noun}` : ''}`, icon: allOpen ? CheckCircleIcon : IssueOpenedIcon, keywords: 'close reopen state', run: () => {
        changeState(app, issues, allOpen ? 'closed' : 'open');
      }});
    }
    if (write) out.push(
      {id: 'status', label: 'Change status…', icon: IssueDraftIcon, shortcut: 'issue.state', keywords: 'workflow state', run: () => {
        openPicker(app, 'status', ids);
      }},
      {id: 'priority', label: 'Set priority…', icon: GraphBarVerticalIcon, shortcut: 'issue.priority', run: () => {
        openPicker(app, 'priority', ids);
      }},
      {id: 'labels', label: 'Change labels…', icon: TagIcon, shortcut: 'issue.labels', keywords: 'tag', run: () => {
        openPicker(app, 'labels', ids);
      }},
      {id: 'assignees', label: 'Change assignees…', icon: PeopleIcon, shortcut: 'issue.assignee', keywords: 'assignee people', run: () => {
        openPicker(app, 'assignees', ids);
      }},
      mine ?
        {id: 'unassign-me', label: 'Unassign me', icon: PersonIcon, run: () => {
          setAssignee(app, issues, me, false);
        }} :
        {id: 'assign-me', label: 'Assign to me', icon: PersonAddIcon, keywords: 'take', run: () => {
          setAssignee(app, issues, me, true);
        }},
      {id: 'milestone', label: 'Set milestone…', icon: MilestoneIcon, shortcut: 'issue.milestone', keywords: 'cycle', run: () => {
        openPicker(app, 'milestone', ids);
      }},
    );
    if (path) {
      const url = new URL(sitePath(app.config, path), location.origin).href;
      out.push(
        {id: 'copy-link', label: 'Copy link', icon: CopyIcon, keywords: 'url', run: () => {
          void navigator.clipboard.writeText(url).then(() => notify(app, {tone: 'success', title: 'Link copied'}), () => undefined);
        }},
        {id: 'new-tab', label: 'Open in a new tab', icon: LinkExternalIcon, run: () => {
          window.open(url, '_blank', 'noopener');
        }},
        {id: 'classic', label: 'Open in the classic UI', icon: BrowserIcon, keywords: 'old forgejo project time tracking', run: () => {
          location.assign(classicHref(app, path));
        }},
      );
    }
    return out;
  });
}
