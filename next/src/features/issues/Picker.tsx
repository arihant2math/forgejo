// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shortcuts open modal pickers; property buttons anchor them. Changes use the intent overlay.
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {cloneElement, type ReactElement, type HTMLAttributes, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {type App, type PickerKind, useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueAssigneeIds, issueDeadline, issueLabelIds, issueMilestone, issueProject, issueState, viewMembers} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Avatar, SelectPanel, type SelectPanelProps} from '@primer/react';
import {ensurePickerLiveRegion} from './pickerLiveRegion.ts';
import {matchOptions, panelGroups, panelItems, selectedItems, type PickOption} from './pickerItems.tsx';
import {shortDate} from './format.ts';
import {labelColor, LabelGlyph, NoPriorityIcon, priorityIcon, StateGlyph, stateLook, statusIcon, UserAvatar} from './cells.tsx';
import {repoLabels} from './candidates.ts';
import {loadPeople, personLogin, repoPeople} from './people.ts';
import {changeState, reopen, setWorkflowStatus} from './actions.ts';
import {clearScope, commonRepo, issuesOf, setAssignee, setLabel, setMilestone} from './edits.ts';
import {exclusiveScope, kindRank, labelKind, scopedValue} from './labels.ts';
import {CalendarIcon, ProjectIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';

const TITLES: Record<PickerKind, string> = {
  status: 'Change status', priority: 'Set priority', labels: 'Change labels', assignees: 'Change assignees', milestone: 'Set milestone',
  reviewers: 'Request reviews', dependency: 'Blocked by', project: 'Put it on a board', due: 'Set the due date',
};

const PLACEHOLDERS: Record<PickerKind, string> = {
  status: 'Change status to…', priority: 'Set priority to…', labels: 'Add or remove labels…', assignees: 'Assign to…', milestone: 'Move to milestone…',
  reviewers: 'Ask for a review from…', dependency: 'Blocked by the issue… (number or title)', project: 'Put it on a board…',
  due: 'Date or “3 days”…',
};

const MAX_DEPENDENCIES = 40;

function LabelSwatch({color}: {color: string}) {
  return <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx={8} cy={8} r={6} fill={labelColor(color)} stroke="var(--borderColor-default)"/>
  </svg>;
}

export const IssuePicker = observer(function IssuePicker() {
  const app = useApp();
  const picker = app.ui.picker;
  if (!picker) return null;
  return <KeyboardPicker app={app} kind={picker.kind} issueIds={picker.issueIds}/>;
});

function KeyboardPicker({app, kind, issueIds}: {app: App; kind: PickerKind; issueIds: readonly number[]}) {
  const active = document.activeElement as HTMLElement;
  // Menu triggers unmount when the picker opens; restore focus to the page's keyboard list.
  const returnTo = active.closest('[role="menu"], [role="dialog"]') ? document.querySelector<HTMLElement>('main [role="listbox"][data-shortcuts]') ?? active : active;
  const anchorRef = useRef<HTMLElement>(returnTo);
  return <PickerPanel app={app} kind={kind} issueIds={issueIds} named open variant="modal"
    anchorRef={anchorRef} renderAnchor={null} onClose={() => {close(app);}}/>;
}

export interface PickerDraft {
  repoId: number;
  labels: number[];
  assignees: number[];
  milestone: number;
  toggleLabel: (label: Label, on: boolean, all: readonly Label[]) => void;
  setAssignee: (id: number, on: boolean) => void;
  setMilestone: (id: number) => void;
}

export function PickerPopover({kind, issueIds = [], draft, trigger}: {kind: PickerKind; issueIds?: readonly number[]; draft?: PickerDraft; trigger: ReactElement}) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  return <PickerPanel app={app} kind={kind} issueIds={issueIds} draft={draft} open={open}
    variant="anchored" onClose={() => {setOpen(false);}} onOpen={() => {setOpen(true);}}
    renderAnchor={(props) => cloneElement(trigger as ReactElement<HTMLAttributes<HTMLElement>>, {...props, children: (trigger as ReactElement<HTMLAttributes<HTMLElement>>).props.children})}/>;
}

function close(app: App): void {
  runInAction(() => {
    app.ui.picker = undefined;
  });
}

const PickerPanel = observer(function PickerPanel({app, kind, issueIds, draft, named = false, open, variant, renderAnchor, anchorRef, onClose, onOpen}: {
  app: App; kind: PickerKind; issueIds: readonly number[]; draft?: PickerDraft | undefined; named?: boolean;
  open: boolean; variant: 'modal' | 'anchored'; renderAnchor: Exclude<SelectPanelProps['renderAnchor'], undefined>;
  anchorRef?: React.RefObject<HTMLElement> | undefined; onClose: () => void; onOpen?: () => void;
}) {
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {if (open) ensurePickerLiveRegion();}, [open]);
  const first = draft?.repoId ?? untracked(() => app.session?.data.pool.model('Issue').get(issueIds[0] ?? 0)?.data.repo_id);
  useEffect(() => {
    if (open && first !== undefined && (kind === 'assignees' || kind === 'reviewers')) loadPeople(app, first);
    if (!open) setQuery('');
  }, [app, first, kind, open]);
  const {options, empty, searched} = open ? pickerOptions(app, kind, issueIds, query, draft) : {options: [], empty: '', searched: false};
  const visible = searched ? options : matchOptions(options, query);
  const items = panelItems(visible, onClose);
  const selected = selectedItems(visible, items);
  const multiple = ['labels', 'assignees', 'reviewers', 'dependency'].includes(kind);
  const issues = named && open ? issuesOf(app, issueIds) : [];
  const one = issues.length === 1 ? issues[0] : undefined;
  const allPulls = issues.every((issue) => untracked(() => issue.data.is_pull));
  const target = one ? `#${one.get('number') > 0 ? String(one.get('number')) : 'new'} ${one.get('title')}` : `${String(issues.length)} ${allPulls ? 'pull requests' : 'issues'}`;
  const fallbackAnchorRef = useRef<HTMLElement>(document.activeElement as HTMLElement);
  const anchor = renderAnchor === null ? {renderAnchor: null, anchorRef: anchorRef ?? fallbackAnchorRef} : {renderAnchor};
  const selection = multiple ? {selected, onSelectedChange: () => undefined} : {selected: selected[0], onSelectedChange: () => undefined};
  return <SelectPanel {...{...anchor}} {...{...selection}} open={open} {...(variant === 'modal' ? {variant: 'modal' as const, onCancel: onClose} : {variant: 'anchored' as const})}
    title={TITLES[kind]} {...(named ? {subtitle: target} : {})} aria-label={TITLES[kind]}
    inputLabel={TITLES[kind]} placeholderText={PLACEHOLDERS[kind]}
    filterValue={query} onFilterChange={setQuery} items={items}
    {...(visible.length <= 50 && visible.some((option) => option.group) ? {groupMetadata: panelGroups(visible)} : {})}
    showSelectedOptionsFirst={false} virtualized={items.length > 50} loading={false}
    {...(items.length === 0 ? {message: {variant: 'empty' as const, title: 'No matches', body: query.trim() && !searched ? `No choices match “${query}”.` : empty}} : {})}
    onOpenChange={(next) => { if (next) onOpen?.(); else onClose(); }}/>;
});

function coverage(issues: readonly Entity<'Issue'>[], has: (i: Entity<'Issue'>) => boolean): boolean | 'mixed' {
  const n = issues.filter(has).length;
  return n === 0 ? false : n === issues.length ? true : 'mixed';
}

/** searched means candidates already match the query (dependency search or parsed due date). */
export function pickerOptions(app: App, kind: PickerKind, issueIds: readonly number[], query: string, draft?: PickerDraft): {options: PickOption[]; empty: string; searched: boolean} {
  const s = app.session;
  if (!s) return {options: [], empty: '', searched: false};
  const pool = s.data.pool;
  const {overlay} = editing(app);
  const issues = issuesOf(app, issueIds);
  if (!issues.length && !draft) return {options: [], empty: 'These issues are not on this device.', searched: false};
  const repoId = draft?.repoId ?? commonRepo(issues);
  if (repoId === undefined && kind !== 'status') return {options: [], empty: 'Pick issues of one repository to change this.', searched: false};
  const hasLabel = (id: number) => (i: Entity<'Issue'>) => issueLabelIds(pool, overlay, i.id).includes(id);
  const options: PickOption[] = [];
  let empty = 'Nothing to choose from in this repository.';

  const labelOption = (l: Label, icon: OcticonType | undefined, keepOpen: boolean): PickOption => {
    const checked = draft ? draft.labels.includes(l.id) : coverage(issues, hasLabel(l.id));
    return {
      value: `l${String(l.id)}`, label: kind === 'labels' ? l.name : scopedValue(l.name), words: l.description, description: kind === 'labels' ? l.description : undefined, checked, keepOpen,
      leading: icon ? <LabelGlyph icon={icon} color={l.color}/> : <LabelSwatch color={l.color}/>,
      onSelect: () => {
        if (draft) draft.toggleLabel(l, checked !== true, repoLabels(pool, draft.repoId));
        else setLabel(app, issues, l, checked !== true);
      },
    };
  };

  if (kind === 'status') {
    const state = coverage(issues, (i) => issueState(overlay, i) === 'open');
    const closed = state === 'mixed' ? 'mixed' : !state;
    const pull = issues.every((i) => untracked(() => i.data.is_pull));
    const statuses = repoId === undefined ? [] : repoLabels(pool, repoId).filter((l) => labelKind(l) === 'status').sort((a, b) => kindRank('status', a.name) - kindRank('status', b.name));
    const anyStatus = statuses.some((l) => draft ? draft.labels.includes(l.id) : coverage(issues, hasLabel(l.id)) !== false);
    if (draft) options.push({value: 'none', label: 'No status', checked: !anyStatus, onSelect: () => {
      for (const l of statuses) draft.toggleLabel(l, false, statuses);
    }});
    else options.push(
      // An unset workflow status is distinct from an "Open" stage.
      {value: 'open', label: 'Open', meta: statuses.length && !anyStatus && state !== false ? 'no status' : undefined, checked: anyStatus ? false : state, leading: <StateGlyph look={stateLook('open', pull, false)}/>, onSelect: () => {
        reopen(app, issues);
      }},
      {value: 'closed', label: 'Closed', checked: anyStatus ? false : closed, leading: <StateGlyph look={stateLook('closed', pull, false)}/>, onSelect: () => {
        changeState(app, issues, 'closed');
      }},
    );
    for (const l of statuses) options.push({...labelOption(l, statusIcon(l.name), false), onSelect: () => {
      if (draft) draft.toggleLabel(l, true, repoLabels(pool, draft.repoId));
      else setWorkflowStatus(app, issues, l);
    }});
  } else if (kind === 'priority' && repoId !== undefined) {
    const priorities = repoLabels(pool, repoId).filter((l) => labelKind(l) === 'priority').sort((a, b) => kindRank('priority', a.name) - kindRank('priority', b.name));
    const scopes = new Set(priorities.map(exclusiveScope));
    if (priorities.length) {
      const none = draft ? !priorities.some((l) => draft.labels.includes(l.id)) : coverage(issues, (i) => !priorities.some((l) => hasLabel(l.id)(i)));
      options.push({value: 'none', label: 'No priority', checked: none, leading: <NoPriorityIcon size={16} className="shrink-0 text-muted"/>, onSelect: () => {
        if (draft) for (const l of priorities) draft.toggleLabel(l, false, priorities);
        else for (const scope of scopes) clearScope(app, issues, scope);
      }});
      for (const l of priorities) options.push(labelOption(l, priorityIcon(l.name), false));
    }
    empty = 'This repository has no priority labels (exclusive "priority/…" labels set them).';
  } else if (kind === 'labels' && repoId !== undefined) {
    // Scoped fields use their own pickers, but label searches must still find them.
    const all = repoLabels(pool, repoId);
    const searching = query.trim() !== '';
    for (const l of all) if (!labelKind(l)) options.push({...labelOption(l, undefined, true), group: searching ? 'Labels' : undefined});
    if (searching) {
      for (const kind of ['status', 'priority'] as const) {
        const fields = all.filter((l) => labelKind(l) === kind).sort((a, b) => kindRank(kind, a.name) - kindRank(kind, b.name));
        for (const l of fields) {
          const o = labelOption(l, kind === 'status' ? statusIcon(l.name) : priorityIcon(l.name), true);
          options.push({
            ...o, group: kind === 'status' ? 'Status field (S)' : 'Priority field (P)', words: `${l.description} ${kind}`,
            onSelect: kind === 'status' && !draft && o.checked !== true ? () => {
              setWorkflowStatus(app, issues, l);
            } : o.onSelect,
          });
        }
      }
    }
    empty = all.length ?
      'This repository has only status and priority labels: set them with Status (S) and Priority (P).' :
      'This repository has no labels.';
  } else if (kind === 'assignees' && repoId !== undefined) {
    const current = draft?.assignees ?? issues.flatMap((i) => issueAssigneeIds(pool, overlay, i.id));
    for (const u of repoPeople(pool, repoId, s.userId, current)) {
      const checked = draft ? draft.assignees.includes(u.id) : coverage(issues, (i) => issueAssigneeIds(pool, overlay, i.id).includes(u.id));
      options.push({
        value: `u${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, meta: personLogin(u), checked, keepOpen: true,
        leading: u.avatar ? <Avatar alt={u.name} src={u.avatar} size={20}/> : <UserAvatar id={u.id}/>,
        onSelect: () => {
          if (draft) draft.setAssignee(u.id, checked !== true);
          else setAssignee(app, issues, u.id, checked !== true);
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
        value: `r${String(u.id)}`, label: u.id === s.userId ? `${u.name} (you)` : u.name, words: u.login, meta: personLogin(u), checked, keepOpen: true,
        leading: u.avatar ? <Avatar alt={u.name} src={u.avatar} size={20}/> : <UserAvatar id={u.id}/>,
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
    const current = (id: number) => draft ? draft.milestone === id : coverage(issues, (i) => issueMilestone(overlay, i) === id);
    options.push({value: 'none', label: 'No milestone', checked: current(0), onSelect: () => {
      if (draft) draft.setMilestone(0);
      else setMilestone(app, issues, 0);
    }});
    const ms = [...pool.model('Milestone').by('repo_id', repoId)].map((m) => m.data)
      .sort((a, b) => (a.state === b.state ? (a.due_on ?? '9').localeCompare(b.due_on ?? '9') || a.title.localeCompare(b.title) : a.state === 'open' ? -1 : 1));
    for (const m of ms) {
      options.push({
        value: `m${String(m.id)}`, label: m.title, words: m.state === 'closed' ? 'closed' : '', checked: current(m.id),
        meta: m.state === 'closed' ? 'closed' : m.due_on ? `due ${shortDate(m.due_on)}` : undefined,
        onSelect: () => {
          if (draft) draft.setMilestone(m.id);
          else setMilestone(app, issues, m.id);
        },
      });
    }
  } else if (kind === 'project' && repoId !== undefined) {
    // Forgejo allows boards from the issue's repository or its owner.
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
    for (const b of boards) options.push({value: `p${String(b.id)}`, label: b.title, icon: ProjectIcon, checked: b.id === pid, onSelect: () => {
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
      value: `due:${label}`, label, meta: shortDate(day), icon: CalendarIcon, checked: dues.every((d) => d === day), onSelect: () => {
        set(day);
      },
    }));
    if (typed) options.push({value: 'due:typed', label: `Due ${shortDate(typed)}`, meta: typed, icon: CalendarIcon, onSelect: () => {
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

export function dueOptions(now: number): {label: string; day: string}[] {
  const d = new Date(now);
  const at = (days: number) => isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
  const toFriday = (5 - d.getDay() + 7) % 7;
  return [
    {label: 'Today', day: at(0)}, {label: 'Tomorrow', day: at(1)}, {label: 'End of this week', day: at(toFriday)},
    {label: 'Next week', day: at(7)}, {label: 'In two weeks', day: at(14)},
    {label: 'In a month', day: isoDay(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()))},
  ];
}

/** Parse absolute or relative due dates; month/day inputs default to this year. */
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
  if (!/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.test(q) || !/\d/.test(q) || /\d{4}/.test(q)) return undefined;
  const t = Date.parse(`${q} ${String(d.getFullYear())}`);
  return Number.isNaN(t) ? undefined : isoDay(new Date(t));
}

function isoDay(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
