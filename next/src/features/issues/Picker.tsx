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
import {type ReactNode, useEffect, useState} from 'react';
import {type App, type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueLabelIds, issueMilestone, issueState, viewMembers} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {
  Avatar, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Icon, LabelDot, LabelIcon, type LucideIcon,
} from '../../ui/index.ts';
import {priorityIcon, StateGlyph, stateLook, statusIcon} from './cells.tsx';
import {repoLabels} from './candidates.ts';
import {loadPeople, repoPeople} from './people.ts';
import {clearScope, commonRepo, issuesOf, setAssignee, setLabel, setMilestone, setState} from './edits.ts';
import {exclusiveScope, kindRank, labelKind, scopedValue} from './labels.ts';

const TITLES: Record<PickerKind, string> = {
  status: 'Change status', priority: 'Set priority', labels: 'Change labels', assignees: 'Change assignees', milestone: 'Set milestone',
  reviewers: 'Request reviews', dependency: 'Blocked by',
};

const PLACEHOLDERS: Record<PickerKind, string> = {
  status: 'Change status to…', priority: 'Set priority to…', labels: 'Add or remove labels…', assignees: 'Assign to…', milestone: 'Move to milestone…',
  reviewers: 'Ask for a review from…', dependency: 'Blocked by the issue… (number or title)',
};

/** Issues offered as dependencies at most (the query narrows them). */
const MAX_DEPENDENCIES = 40;

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
  const first = untracked(() => app.session?.data.pool.model('Issue').get(issueIds[0] ?? 0)?.data.repo_id);
  useEffect(() => {
    if (first !== undefined && (kind === 'assignees' || kind === 'reviewers')) loadPeople(app, first);
  }, [app, first, kind]);
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
    // Priorities are exclusive scoped labels (PLAN §7.3): say so where there are none.
    if (!priorities.length) groupTitle = 'This repository has no priority labels (exclusive "priority/…" labels set them)';
  } else if (kind === 'labels' && repoId !== undefined) {
    // Status and priority labels have their own pickers (S, P).
    for (const l of repoLabels(pool, repoId)) if (!labelKind(l)) options.push(labelOption(l, undefined, true));
  } else if (kind === 'assignees' && repoId !== undefined) {
    const current = issues.flatMap((i) => issueAssigneeIds(pool, overlay, i.id));
    for (const u of repoPeople(pool, repoId, s.userId, current)) {
      const checked = coverage(issues, (i) => issueAssigneeIds(pool, overlay, i.id).includes(u.id));
      options.push({
        key: `u${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, checked, keepOpen: true,
        leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
        run: done(() => {
          setAssignee(app, issues, u.id, checked !== 'all');
        }),
      });
    }
  } else if (kind === 'reviewers' && repoId !== undefined) {
    const requested = (i: Entity<'Issue'>) => viewMembers(pool, overlay, 'ReviewRequest', i.id);
    const posters = new Set(issues.map((i) => untracked(() => i.data.poster_id)));
    for (const u of repoPeople(pool, repoId, s.userId)) {
      if (posters.has(u.id)) continue; // nobody reviews their own pull request
      const checked = coverage(issues, (i) => requested(i).has(u.id));
      options.push({
        key: `r${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, checked, keepOpen: true,
        leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
        run: done(() => {
          runInAction(() => {
            for (const i of issues) {
              if (requested(i).has(u.id) === (checked !== 'all')) continue;
              editing(app).intents.submit({kind: 'issue.reviewer', issueId: i.id, repoId: i.data.repo_id, userId: u.id, add: checked !== 'all'});
            }
          });
        }),
      });
    }
  } else if (kind === 'dependency' && repoId !== undefined) {
    const own = new Set(issues.map((i) => i.id));
    const blockedBy = (i: Entity<'Issue'>) => viewMembers(pool, overlay, 'IssueDependency', i.id);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const n = /^#?(\d+)$/.exec(words[0] ?? '')?.[1];
    const all = untracked(() => [...pool.model('Issue').by('repo_id', repoId)].filter((i) => !own.has(i.id))
      .filter((i) => blockedBy(issues[0] ?? i).has(i.id) || (n ? String(i.data.number).startsWith(n) : words.every((w) => i.data.title.toLowerCase().includes(w))))
      .sort((a, b) => Number(blockedBy(issues[0] ?? a).has(b.id)) - Number(blockedBy(issues[0] ?? b).has(a.id)) ||
        Number(a.data.state !== 'open') - Number(b.data.state !== 'open') || b.data.number - a.data.number)
      .slice(0, MAX_DEPENDENCIES));
    for (const d of all) {
      const checked = coverage(issues, (i) => blockedBy(i).has(d.id));
      options.push({
        key: `d${String(d.id)}`, label: `#${String(d.data.number)} ${d.data.title}`, words: String(d.data.number), checked, keepOpen: true,
        leading: <StateGlyph look={stateLook(d.data.state, d.data.is_pull, false)}/>,
        run: done(() => {
          runInAction(() => {
            for (const i of issues) {
              if (blockedBy(i).has(d.id) === (checked !== 'all')) continue;
              editing(app).intents.submit({kind: 'issue.dependency', issueId: i.id, repoId: i.data.repo_id, dependencyId: d.id, add: checked !== 'all'});
            }
          });
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
  // The dependency options are already the query's matches (searched over the repository's issues).
  const shown = words.length && kind !== 'dependency' ? options.filter((o) => words.every((w) => `${o.label} ${o.words ?? ''}`.toLowerCase().includes(w))) : options;
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
