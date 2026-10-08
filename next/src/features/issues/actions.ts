// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The actions on issues, defined once: a row's context menu, the ⌘K
// palette (for the list's selection or cursor, or the open issue) and the
// shortcuts (S/L/A/M/P) offer the same ones, with the same labels and keys
// (PLAN §5.6).

import {CircleCheck, CircleDashed, CircleDot, Copy, CornerDownLeft, ExternalLink, Milestone, SignalHigh, Tag, UserMinus, UserPlus, Users} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {sitePath} from '../../app/config.ts';
import {notify} from '../../app/notices.ts';
import type {ShortcutId} from '../../app/shortcuts/index.ts';
import type {App, PickerKind} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueState} from '../../intents/view.ts';
import type {LucideIcon} from '../../ui/index.ts';
import {issuePath, setAssignee, setState} from './edits.ts';

export interface IssueAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: ShortcutId;
  /** Extra words the palette finds it by. */
  keywords?: string;
  run(): void;
}

/** Opens an issue picker (S/L/A/M/P) for these issues. */
export function openPicker(app: App, kind: PickerKind, issueIds: readonly number[]): void {
  if (!issueIds.length) return;
  runInAction(() => {
    app.ui.picker = {kind, issueIds: [...issueIds]};
  });
}

/** The actions available on these issues (untracked: call when a menu opens). */
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
    const out: IssueAction[] = [];
    if (path && opts.navigate) {
      const go = opts.navigate;
      out.push({id: 'open', label: 'Open', icon: CornerDownLeft, run: () => {
        go(path);
      }});
    }
    out.push(
      {id: 'state', label: allOpen ? `Close${noun ? ` ${noun}` : ''}` : `Reopen${noun ? ` ${noun}` : ''}`, icon: allOpen ? CircleCheck : CircleDot, keywords: 'close reopen state', run: () => {
        setState(app, issues, allOpen ? 'closed' : 'open');
      }},
      {id: 'status', label: 'Change status…', icon: CircleDashed, shortcut: 'issue.state', keywords: 'workflow state', run: () => {
        openPicker(app, 'status', ids);
      }},
      {id: 'priority', label: 'Set priority…', icon: SignalHigh, shortcut: 'issue.priority', run: () => {
        openPicker(app, 'priority', ids);
      }},
      {id: 'labels', label: 'Change labels…', icon: Tag, shortcut: 'issue.labels', keywords: 'tag', run: () => {
        openPicker(app, 'labels', ids);
      }},
      {id: 'assignees', label: 'Change assignees…', icon: Users, shortcut: 'issue.assignee', keywords: 'assignee people', run: () => {
        openPicker(app, 'assignees', ids);
      }},
      mine ?
        {id: 'unassign-me', label: 'Unassign me', icon: UserMinus, run: () => {
          setAssignee(app, issues, me, false);
        }} :
        {id: 'assign-me', label: 'Assign to me', icon: UserPlus, keywords: 'take', run: () => {
          setAssignee(app, issues, me, true);
        }},
      {id: 'milestone', label: 'Set milestone…', icon: Milestone, shortcut: 'issue.milestone', keywords: 'cycle', run: () => {
        openPicker(app, 'milestone', ids);
      }},
    );
    if (path) {
      const url = new URL(sitePath(app.config, path), location.origin).href;
      out.push(
        {id: 'copy-link', label: 'Copy link', icon: Copy, keywords: 'url', run: () => {
          void navigator.clipboard.writeText(url).then(() => notify(app, {tone: 'success', title: 'Link copied'}), () => undefined);
        }},
        {id: 'new-tab', label: 'Open in a new tab', icon: ExternalLink, run: () => {
          window.open(url, '_blank', 'noopener');
        }},
      );
    }
    return out;
  });
}
