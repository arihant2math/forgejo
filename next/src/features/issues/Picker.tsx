// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The issue pickers (S status, P priority, L labels, A assignees, M
// milestone; reviewers, dependencies, project and due date): the pool's
// candidates, acting on one issue or a selection. Like Linear's, they filter as
// you type and apply on Enter, open on the current value, and the multi-value
// ones (labels, assignees) stay open for more. One list (CommandPick), shown
// two ways as in Linear: a key opens it as a command menu that names its
// issues, a click on a property under that property (PickerPopover).

import {CalendarClock, KanbanSquare, SignalZero} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactElement, useEffect, useState} from 'react';
import {type App, type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueDeadline, issueLabelIds, issueMilestone, issueProject, issueState, viewMembers} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Avatar, CommandDialog, CommandPick, CommandPopover, Icon, LabelDot, LabelIcon, type LucideIcon, matchOptions, type PickOption} from '../../ui/index.ts';
import {shortDate} from './format.ts';
import {priorityIcon, StateGlyph, stateLook, statusIcon} from './cells.tsx';
import {repoLabels} from './candidates.ts';
import {loadPeople, repoPeople} from './people.ts';
import {changeState, reopen, setWorkflowStatus} from './actions.ts';
import {clearScope, commonRepo, issuesOf, setAssignee, setLabel, setMilestone} from './edits.ts';
import {exclusiveScope, kindRank, labelKind, scopedValue} from './labels.ts';

const TITLES: Record<PickerKind, string> = {
  status: 'Change status', priority: 'Set priority', labels: 'Change labels', assignees: 'Change assignees', milestone: 'Set milestone',
  reviewers: 'Request reviews', dependency: 'Blocked by', project: 'Put it on a board', due: 'Set the due date',
};

const PLACEHOLDERS: Record<PickerKind, string> = {
  status: 'Change status to…', priority: 'Set priority to…', labels: 'Add or remove labels…', assignees: 'Assign to…', milestone: 'Move to milestone…',
  reviewers: 'Ask for a review from…', dependency: 'Blocked by the issue… (number or title)', project: 'Put it on a board…',
  due: 'Due on… (a date, "tomorrow", "3 days", "2 weeks")',
};

/** Issues offered as dependencies at most (the query narrows them). */
const MAX_DEPENDENCIES = 40;

/** The picker a key opened (app.ui.picker): a command menu naming its issues; stays mounted while it fades out. */
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
    <CommandDialog open={Boolean(p)} label={TITLES[shown.kind]} bare onOpenChange={(open) => {
      if (!open) close(app);
    }}>
      <PickerList key={n} app={app} kind={shown.kind} issueIds={shown.issueIds} named onClose={() => {
        close(app);
      }}/>
    </CommandDialog>
  );
});

/** The same picker under a property (a click in the issue's side panel). */
export function PickerPopover({kind, issueIds, trigger}: {kind: PickerKind; issueIds: readonly number[]; trigger: ReactElement}) {
  const app = useApp();
  return (
    <CommandPopover trigger={trigger} label={TITLES[kind]} placeholder={PLACEHOLDERS[kind]} options={[]} width="md"
      render={(onClose) => <PickerList app={app} kind={kind} issueIds={issueIds} onClose={onClose}/>}/>
  );
}

function close(app: App): void {
  runInAction(() => {
    app.ui.picker = undefined;
  });
}

/** The list itself: `named` says which issues it changes above the field (a key does not show which row it was). */
const PickerList = observer(function PickerList({app, kind, issueIds, named = false, onClose}: {
  app: App; kind: PickerKind; issueIds: readonly number[]; named?: boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const first = untracked(() => app.session?.data.pool.model('Issue').get(issueIds[0] ?? 0)?.data.repo_id);
  useEffect(() => {
    if (first !== undefined && (kind === 'assignees' || kind === 'reviewers')) loadPeople(app, first);
  }, [app, first, kind]);
  const {options, empty, searched} = pickerOptions(app, kind, issueIds, query);
  const issues = issuesOf(app, issueIds);
  const allPulls = issues.every((i) => untracked(() => i.data.is_pull));
  const one = issues.length === 1 ? issues[0] : undefined;
  const target = !named || !issues.length ? undefined : one ?
    <><span className="tabular-nums">#{one.get('number') > 0 ? String(one.get('number')) : 'new'}</span> {one.get('title')}</> :
    `${String(issues.length)} ${allPulls ? 'pull requests' : 'issues'}`;
  return (
    <CommandPick label={TITLES[kind]} placeholder={PLACEHOLDERS[kind]} options={options} empty={empty} onClose={onClose} target={target}
      query={query} onQueryChange={setQuery} filtered={searched}/>
  );
});

/** How many of the issues have a property: all (checked), some (mixed) or none. */
function coverage(issues: readonly Entity<'Issue'>[], has: (i: Entity<'Issue'>) => boolean): boolean | 'mixed' {
  const n = issues.filter(has).length;
  return n === 0 ? false : n === issues.length ? true : 'mixed';
}

/**
 * A picker's options for these issues (read in an observer: they follow the pool). `searched`: the options are
 * the query's matches already (dependencies search the repository's issues; a due date parses the query).
 */
export function pickerOptions(app: App, kind: PickerKind, issueIds: readonly number[], query: string): {options: PickOption[]; empty: string; searched: boolean} {
  const s = app.session;
  if (!s) return {options: [], empty: '', searched: false};
  const pool = s.data.pool;
  const {overlay} = editing(app);
  const issues = issuesOf(app, issueIds);
  if (!issues.length) return {options: [], empty: 'These issues are not on this device.', searched: false};
  const repoId = commonRepo(issues);
  if (repoId === undefined && kind !== 'status') return {options: [], empty: 'Pick issues of one repository to change this.', searched: false};
  const hasLabel = (id: number) => (i: Entity<'Issue'>) => issueLabelIds(pool, overlay, i.id).includes(id);
  const options: PickOption[] = [];
  let empty = 'Nothing to choose from in this repository.';

  const labelOption = (l: Label, icon: LucideIcon | undefined, keepOpen: boolean): PickOption => {
    const checked = coverage(issues, hasLabel(l.id));
    return {
      value: `l${String(l.id)}`, label: kind === 'labels' ? l.name : scopedValue(l.name), words: l.description, checked, keepOpen,
      leading: icon ? <LabelIcon icon={icon} color={l.color}/> : <LabelDot color={l.color}/>,
      onSelect: () => {
        setLabel(app, issues, l, checked !== true);
      },
    };
  };

  if (kind === 'status') {
    const state = coverage(issues, (i) => issueState(overlay, i) === 'open');
    const closed = state === 'mixed' ? 'mixed' : !state;
    const pull = issues.every((i) => untracked(() => i.data.is_pull));
    const statuses = repoId === undefined ? [] : repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status').sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
    const anyStatus = statuses.some((l) => coverage(issues, hasLabel(l.id)) !== false);
    // The state is the value when no workflow status is set (with one, the status is).
    options.push(
      {value: 'open', label: 'Open', checked: anyStatus ? false : state, leading: <StateGlyph look={stateLook('open', pull, false)}/>, onSelect: () => {
        reopen(app, issues);
      }},
      {value: 'closed', label: 'Closed', checked: anyStatus ? false : closed, leading: <StateGlyph look={stateLook('closed', pull, false)}/>, onSelect: () => {
        changeState(app, issues, 'closed');
      }},
    );
    // A status is Linear's: done and canceled close the issue, the others reopen it.
    for (const l of statuses) options.push({...labelOption(l, statusIcon(l.name), false), onSelect: () => {
      setWorkflowStatus(app, issues, l);
    }});
  } else if (kind === 'priority' && repoId !== undefined) {
    const priorities = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'priority').sort((a, b) => kindRank('priority', a.name) - kindRank('priority', b.name));
    const scopes = new Set(priorities.map(exclusiveScope));
    if (priorities.length) {
      const none = coverage(issues, (i) => !priorities.some((l) => hasLabel(l.id)(i)));
      options.push({value: 'none', label: 'No priority', checked: none, leading: <Icon icon={SignalZero} className="text-fg-subtle"/>, onSelect: () => {
        for (const scope of scopes) clearScope(app, issues, scope);
      }});
      for (const l of priorities) options.push(labelOption(l, priorityIcon(l.name), false));
    }
    // Priorities are exclusive scoped labels (PLAN §7.3): say so where there are none.
    empty = 'This repository has no priority labels (exclusive "priority/…" labels set them).';
  } else if (kind === 'labels' && repoId !== undefined) {
    // Status and priority labels have their own pickers (S, P).
    for (const l of repoLabels(pool, repoId)) if (!labelKind(l)) options.push(labelOption(l, undefined, true));
    empty = 'This repository has no labels.';
  } else if (kind === 'assignees' && repoId !== undefined) {
    const current = issues.flatMap((i) => issueAssigneeIds(pool, overlay, i.id));
    for (const u of repoPeople(pool, repoId, s.userId, current)) {
      const checked = coverage(issues, (i) => issueAssigneeIds(pool, overlay, i.id).includes(u.id));
      options.push({
        value: `u${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, checked, keepOpen: true,
        leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
        onSelect: () => {
          setAssignee(app, issues, u.id, checked !== true);
        },
      });
    }
  } else if (kind === 'reviewers' && repoId !== undefined) {
    const requested = (i: Entity<'Issue'>) => viewMembers(pool, overlay, 'ReviewRequest', i.id);
    const posters = new Set(issues.map((i) => untracked(() => i.data.poster_id)));
    for (const u of repoPeople(pool, repoId, s.userId)) {
      if (posters.has(u.id)) continue; // nobody reviews their own pull request
      const checked = coverage(issues, (i) => requested(i).has(u.id));
      options.push({
        value: `r${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, checked, keepOpen: true,
        leading: <Avatar name={u.name} src={u.avatar} size="sm"/>,
        onSelect: () => {
          runInAction(() => {
            for (const i of issues) {
              if (requested(i).has(u.id) === (checked !== true)) continue;
              editing(app).intents.submit({kind: 'issue.reviewer', issueId: i.id, repoId: i.data.repo_id, userId: u.id, add: checked !== true});
            }
          });
        },
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
        value: `d${String(d.id)}`, label: `#${String(d.data.number)} ${d.data.title}`, words: String(d.data.number), checked, keepOpen: true,
        leading: <StateGlyph look={stateLook(d.data.state, d.data.is_pull, false)}/>,
        onSelect: () => {
          runInAction(() => {
            for (const i of issues) {
              if (blockedBy(i).has(d.id) === (checked !== true)) continue;
              editing(app).intents.submit({kind: 'issue.dependency', issueId: i.id, repoId: i.data.repo_id, dependencyId: d.id, add: checked !== true});
            }
          });
        },
      });
    }
    empty = 'No other issue of this repository matches.';
    return {options, empty, searched: true};
  } else if (kind === 'milestone' && repoId !== undefined) {
    const current = (id: number) => coverage(issues, (i) => issueMilestone(overlay, i) === id);
    options.push({value: 'none', label: 'No milestone', checked: current(0), onSelect: () => {
      setMilestone(app, issues, 0);
    }});
    const ms = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data)
      .sort((a, b) => (a.state === b.state ? (a.due_on ?? '9').localeCompare(b.due_on ?? '9') || a.title.localeCompare(b.title) : a.state === 'open' ? -1 : 1));
    for (const m of ms) {
      options.push({
        value: `m${String(m.id)}`, label: m.title, words: m.state === 'closed' ? 'closed' : '', checked: current(m.id),
        meta: m.state === 'closed' ? 'closed' : m.due_on ? `due ${shortDate(m.due_on)}` : undefined,
        onSelect: () => {
          setMilestone(app, issues, m.id);
        },
      });
    }
  } else if (kind === 'project' && repoId !== undefined) {
    // One issue (the side panel's): the boards it can go on, its repository's and its owner's (Forgejo's rule).
    const issue = issues[0];
    const repo = pool.model('Repository').get(repoId)?.data;
    const pid = issue ? issueProject(pool, overlay, issue.id).project : 0;
    const set = (projectId: number) => {
      if (!issue || projectId === pid) return;
      runInAction(() => {
        editing(app).intents.submit({kind: 'issue.project', issueId: issue.id, repoId, projectId, columnId: 0, base: pid});
      });
    };
    if (pid) options.push({value: 'none', label: 'No project', checked: false, onSelect: () => {
      set(0);
    }});
    const boards = [...pool.model('Project').all()].map((e) => e.data)
      .filter((p) => !p.closed && (p.repo_id === repoId || (p.repo_id === 0 && p.owner_id === repo?.owner_id)))
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const b of boards) options.push({value: `p${String(b.id)}`, label: b.title, icon: KanbanSquare, checked: b.id === pid, onSelect: () => {
      set(b.id);
    }});
    empty = 'No open board of this repository or its owner is on this device.';
  } else if (kind === 'due') {
    const dues = issues.map((i) => issueDeadline(overlay, i)?.slice(0, 10) ?? null);
    const set = (due: string | null) => {
      runInAction(() => {
        issues.forEach((i, k) => {
          const base = dues[k] ?? null;
          if (base === due) return;
          editing(app).intents.submit({kind: 'issue.deadline', issueId: i.id, repoId: i.data.repo_id, due, base});
        });
      });
    };
    const typed = parseDue(query);
    const presets = dueOptions(Date.now()).map(({label, day}) => ({
      value: `due:${label}`, label, meta: shortDate(day), icon: CalendarClock, checked: dues.every((d) => d === day), onSelect: () => {
        set(day);
      },
    }));
    if (typed) options.push({value: 'due:typed', label: `Due ${shortDate(typed)}`, meta: typed, icon: CalendarClock, onSelect: () => {
      set(typed);
    }});
    options.push(...matchOptions([
      {value: 'due:none', label: 'No due date', checked: dues.every((d) => d === null), onSelect: () => {
        set(null);
      }},
      ...presets,
    ], typed ? '' : query));
    empty = 'Type a date (2026-10-20, "oct 20", "3 days", "2 weeks").';
    return {options, empty, searched: true};
  }
  return {options, empty, searched: false};
}

/** The due date presets (Linear's): today, tomorrow, the end of the week, next week, in two weeks, in a month. */
export function dueOptions(now: number): {label: string; day: string}[] {
  const d = new Date(now);
  const at = (days: number) => isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
  const toFriday = (5 - d.getDay() + 7) % 7;
  const toMonday = ((1 - d.getDay() + 7) % 7) || 7;
  return [
    {label: 'Today', day: at(0)}, {label: 'Tomorrow', day: at(1)}, {label: 'End of this week', day: at(toFriday)},
    {label: 'Next week', day: at(toMonday)}, {label: 'In two weeks', day: at(14)},
    {label: 'In a month', day: isoDay(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()))},
  ];
}

/** A typed due date: "2026-10-20", "oct 20" (this year), "3 days", "2 weeks"; undefined otherwise. */
export function parseDue(query: string, now = Date.now()): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) return Number.isNaN(Date.parse(q)) ? undefined : q;
  const rel = /^(?:in\s+)?(\d{1,3})\s*(d|days?|w|weeks?)$/.exec(q);
  const d = new Date(now);
  if (rel?.[1] && rel[2]) {
    const n = Number(rel[1]) * (rel[2].startsWith('w') ? 7 : 1);
    return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  }
  // A month and a day ("oct 20", "20 october"): this year (no year given).
  if (!/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.test(q) || !/\d/.test(q) || /\d{4}/.test(q)) return undefined;
  const t = Date.parse(`${q} ${String(d.getFullYear())}`);
  return Number.isNaN(t) ? undefined : isoDay(new Date(t));
}

function isoDay(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
