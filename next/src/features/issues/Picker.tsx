// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The issue pickers (S status, P priority, L labels, A assignees, M
// milestone): a command menu over the pool's candidates, acting on one issue
// or a selection. Like Linear's, they filter as you type and apply on Enter;
// the multi-value ones (labels, assignees) stay open for more. Its own
// chunk, loaded when a picker first opens (or when idle).

import {SignalZero} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {type App, type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueLabelIds, issueMilestone, issueState} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {
  Avatar, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Icon, LabelDot, LabelIcon, type LucideIcon,
} from '../../ui/index.ts';
import {priorityIcon, StateGlyph, stateLook, statusIcon} from './cells.tsx';
import {assigneeCandidates, repoLabels} from './candidates.ts';
import {clearScope, commonRepo, issuesOf, setAssignee, setLabel, setMilestone, setState} from './edits.ts';
import {exclusiveScope, kindRank, labelKind, scopedValue} from './labels.ts';

const TITLES: Record<PickerKind, string> = {
  status: 'Change status', priority: 'Set priority', labels: 'Change labels', assignees: 'Change assignees', milestone: 'Set milestone',
};

const PLACEHOLDERS: Record<PickerKind, string> = {
  status: 'Change status to…', priority: 'Set priority to…', labels: 'Add or remove labels…', assignees: 'Assign to…', milestone: 'Move to milestone…',
};

/** The picker the app has open (app.ui.picker); stays mounted while it fades out. */
export const IssuePicker = observer(function IssuePicker() {
  const app = useApp();
  const p = app.ui.picker;
  const [last, setLast] = useState(p);
  const [n, setN] = useState(0);
  if (p && p !== last) {
    setLast(p);
    setN(n + 1);
  }
  const shown = p ?? last;
  if (!shown) return null;
  return (
    <CommandDialog open={Boolean(p)} label={TITLES[shown.kind]} onOpenChange={(open) => {
      if (!open) close(app);
    }}>
      <PickerBody key={n} app={app} kind={shown.kind} issueIds={shown.issueIds}/>
    </CommandDialog>
  );
});

function close(app: App): void {
  runInAction(() => {
    app.ui.picker = undefined;
  });
}

interface Option {
  key: string;
  label: string;
  /** Searched besides the label. */
  words?: string;
  leading: ReactNode;
  /** all: every target has it; some: a few. */
  checked: 'all' | 'some' | 'none';
  /** Stay open after choosing (multi-value fields). */
  keepOpen?: boolean;
  run(): void;
}

/** How many of the issues have a property. */
function coverage(issues: readonly Entity<'Issue'>[], has: (i: Entity<'Issue'>) => boolean): Option['checked'] {
  const n = issues.filter(has).length;
  return n === 0 ? 'none' : n === issues.length ? 'all' : 'some';
}

const PickerBody = observer(function PickerBody({app, kind, issueIds}: {app: App; kind: PickerKind; issueIds: readonly number[]}) {
  const [query, setQuery] = useState('');
  const s = app.session;
  if (!s) return null;
  const pool = s.data.pool;
  const {overlay} = editing(app);
  const issues = issuesOf(app, issueIds);
  const repoId = commonRepo(issues);
  const hasLabel = (id: number) => (i: Entity<'Issue'>) => issueLabelIds(pool, overlay, i.id).includes(id);
  const options: Option[] = [];
  const done = (fn: () => void) => () => {
    fn();
  };

  const labelOption = (l: Label, icon: LucideIcon | undefined, keepOpen: boolean): Option => {
    const checked = coverage(issues, hasLabel(l.id));
    return {
      key: `l${String(l.id)}`, label: kind === 'labels' ? l.name : scopedValue(l.name), words: l.description, checked, keepOpen,
      leading: icon ? <LabelIcon icon={icon} color={l.color}/> : <LabelDot color={l.color}/>,
      run: done(() => {
        setLabel(app, issues, l, checked !== 'all');
      }),
    };
  };

  let groupTitle = TITLES[kind];
  if (repoId === undefined && kind !== 'status' && issues.length) {
    groupTitle = '';
  } else if (kind === 'status') {
    const state = coverage(issues, (i) => issueState(overlay, i) === 'open');
    const closed: Option['checked'] = state === 'all' ? 'none' : state === 'none' ? 'all' : 'some';
    const pull = issues.every((i) => untracked(() => i.data.is_pull));
    options.push(
      {key: 'open', label: 'Open', checked: state, leading: <StateGlyph look={stateLook('open', pull, false)}/>, run: done(() => {
        setState(app, issues, 'open');
      })},
      {key: 'closed', label: 'Closed', checked: closed, leading: <StateGlyph look={stateLook('closed', pull, false)}/>, run: done(() => {
        setState(app, issues, 'closed');
      })},
    );
    if (repoId !== undefined) {
      const statuses = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status').sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
      for (const l of statuses) options.push(labelOption(l, statusIcon(l.name), false));
    }
  } else if (kind === 'priority' && repoId !== undefined) {
    const priorities = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'priority').sort((a, b) => kindRank('priority', a.name) - kindRank('priority', b.name));
    const scopes = new Set(priorities.map(exclusiveScope));
    const none = coverage(issues, (i) => !priorities.some((l) => hasLabel(l.id)(i)));
    options.push({key: 'none', label: 'No priority', checked: none, leading: <Icon icon={SignalZero} className="text-fg-subtle"/>, run: done(() => {
      for (const scope of scopes) clearScope(app, issues, scope);
    })});
    for (const l of priorities) options.push(labelOption(l, priorityIcon(l.name), false));
  } else if (kind === 'labels' && repoId !== undefined) {
    // Status and priority labels have their own pickers (S, P).
    for (const l of repoLabels(pool, repoId)) if (!labelKind(l)) options.push(labelOption(l, undefined, true));
  } else if (kind === 'assignees' && repoId !== undefined) {
    const users = pool.model('User');
    const ids = new Set(assigneeCandidates(pool, repoId, s.userId));
    for (const i of issues) for (const id of issueAssigneeIds(pool, overlay, i.id)) ids.add(id);
    const people = [...ids].map((id) => users.get(id)).filter((u): u is Entity<'User'> => u !== undefined)
      .map((u) => u.data).sort((a, b) => (a.id === s.userId ? -1 : b.id === s.userId ? 1 : a.login.localeCompare(b.login)));
    for (const u of people) {
      const checked = coverage(issues, (i) => issueAssigneeIds(pool, overlay, i.id).includes(u.id));
      options.push({
        key: `u${String(u.id)}`, label: u.id === s.userId ? `${u.full_name || u.login} (you)` : u.full_name || u.login, words: u.login, checked, keepOpen: true,
        leading: <Avatar name={u.full_name || u.login} src={u.avatar_url || undefined} size="sm"/>,
        run: done(() => {
          setAssignee(app, issues, u.id, checked !== 'all');
        }),
      });
    }
  } else if (kind === 'milestone' && repoId !== undefined) {
    const current = (id: number) => coverage(issues, (i) => issueMilestone(overlay, i) === id);
    const none = current(0);
    options.push({key: 'none', label: 'No milestone', checked: none, leading: undefined, run: done(() => {
      setMilestone(app, issues, 0);
    })});
    const ms = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data)
      .sort((a, b) => (a.state === b.state ? (a.due_on ?? '9').localeCompare(b.due_on ?? '9') || a.title.localeCompare(b.title) : a.state === 'open' ? -1 : 1));
    for (const m of ms) {
      const checked = current(m.id);
      options.push({
        key: `m${String(m.id)}`, label: m.title, words: m.state === 'closed' ? 'closed' : '', checked,
        leading: undefined,
        run: done(() => {
          setMilestone(app, issues, m.id);
        }),
      });
    }
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? options.filter((o) => words.every((w) => `${o.label} ${o.words ?? ''}`.toLowerCase().includes(w))) : options;
  const allPulls = issues.every((i) => untracked(() => i.data.is_pull));
  const noun = issues.length > 1 ? `${String(issues.length)} ${allPulls ? 'pull requests' : 'issues'}` : '';
  return (
    <>
      <CommandInput value={query} onValueChange={setQuery} placeholder={noun ? `${PLACEHOLDERS[kind]} (${noun})` : PLACEHOLDERS[kind]}/>
      <CommandList>
        {!issues.length && <CommandEmpty>These issues are not on this device.</CommandEmpty>}
        {issues.length > 0 && !groupTitle && <CommandEmpty>Pick issues of one repository to change this.</CommandEmpty>}
        {groupTitle && !shown.length && <CommandEmpty>{options.length ? 'Nothing matches.' : 'Nothing to choose from in this repository.'}</CommandEmpty>}
        {groupTitle && shown.length > 0 && (
          <CommandGroup heading={groupTitle}>
            {shown.map((o) => (
              <CommandItem key={o.key} value={o.key} leading={o.leading} checked={o.checked === 'some' ? 'mixed' : o.checked === 'all'} onSelect={() => {
                o.run();
                if (!o.keepOpen) close(app);
              }}>
                {o.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
});
