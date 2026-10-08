// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observer leaves that show one aspect of an issue (PLAN §1 "one delta, one
// cell"): each reads only the fields it shows, through the overlay
// (intents/view.ts), so a delta or a local change re-renders that cell and
// nothing around it. Rows, the issue header and the sidebar share them.
// Hints are native titles (Hint): a Radix tooltip per cell would cost a
// mount per cell for every row scrolled into view.

import {
  Circle, CircleCheck, CircleDashed, CircleDot, CircleDotDashed, CircleEllipsis, CircleX, GitMerge, GitPullRequest,
  GitPullRequestClosed, OctagonAlert, SignalHigh, SignalLow, SignalMedium, SignalZero,
} from 'lucide-react';
import {compareStructural, computed, type IComputedValue} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useApp} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {editing} from '../../intents/session.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {issueAssigneeIds, issueLabelIds, issueMilestone, issueState} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Avatar, AvatarGroup, Hint, Icon, LabelChip, LabelIcon, type LucideIcon} from '../../ui/index.ts';
import {ago, fullDate} from './format.ts';
import {kindRank, labelKind, scopedValue, statusStage, type StatusStage} from './labels.ts';

export function usePool(): Pool {
  const s = useApp().session;
  if (!s) throw new Error('no session');
  return s.data.pool;
}

export function useOverlay() {
  return editing(useApp()).overlay;
}

/** An issue's labels as rows show them: its status and priority (scoped labels) and the others. */
export interface LabelView {
  status: Label | undefined;
  priority: Label | undefined;
  /** The other labels, by name. */
  other: Label[];
}

const labelViews = new WeakMap<Entity<'Issue'>, IComputedValue<LabelView>>();

/**
 * The labels of an issue as the user sees them (overlay included), split
 * into status / priority / the rest: one MobX computation per issue shared by
 * the cells that show them (a row's status, priority and label cells), so
 * they resolve the issue's labels once, and re-render only when it changes.
 */
export function labelView(pool: Pool, overlay: Overlay, issue: Entity<'Issue'>): LabelView {
  let c = labelViews.get(issue);
  if (!c) {
    c = computed(() => {
      const store = pool.model('Label');
      const view: LabelView = {status: undefined, priority: undefined, other: []};
      for (const id of issueLabelIds(pool, overlay, issue.id)) {
        const l = store.get(id)?.data;
        if (!l) continue;
        const kind = labelKind(l);
        if (kind === undefined) view.other.push(l);
        else if (!view[kind] || kindRank(kind, l.name) < kindRank(kind, view[kind].name)) view[kind] = l;
      }
      view.other.sort((x, y) => x.name.localeCompare(y.name));
      return view;
    }, {equals: compareStructural});
    labelViews.set(issue, c);
  }
  return c.get();
}

export function useLabelView(issue: Entity<'Issue'>): LabelView {
  return labelView(usePool(), useOverlay(), issue);
}

const STAGE_ICONS: Record<StatusStage, LucideIcon> = {
  backlog: CircleDashed, todo: Circle, started: CircleDotDashed, review: CircleEllipsis, done: CircleCheck, canceled: CircleX,
};

export function statusIcon(name: string): LucideIcon {
  const stage = statusStage(scopedValue(name));
  return stage ? STAGE_ICONS[stage] : Circle;
}

const PRIORITY_ICONS: LucideIcon[] = [OctagonAlert, SignalHigh, SignalMedium, SignalLow, SignalZero];

export function priorityIcon(name: string): LucideIcon {
  return PRIORITY_ICONS[Math.min(4, Math.max(0, Math.round(kindRank('priority', name))))] ?? SignalMedium;
}

interface StateLook {
  icon: LucideIcon;
  tone: keyof typeof STATE_TONES;
  label: string;
}

const STATE_TONES = {open: 'text-success', merged: 'text-done', done: 'text-done', closed: 'text-danger'} as const;

/** Open/closed/merged as Forgejo shows it, without workflow labels. */
export function stateLook(state: string, pull: boolean, merged: boolean): StateLook {
  if (pull) {
    if (merged) return {icon: GitMerge, tone: 'merged', label: 'Merged'};
    return state === 'open' ? {icon: GitPullRequest, tone: 'open', label: 'Open'} : {icon: GitPullRequestClosed, tone: 'closed', label: 'Closed'};
  }
  return state === 'open' ? {icon: CircleDot, tone: 'open', label: 'Open'} : {icon: CircleCheck, tone: 'done', label: 'Closed'};
}

/** The icon of a state look in its colour. */
export function StateGlyph({look}: {look: StateLook}) {
  return <Icon icon={look.icon} className={STATE_TONES[look.tone]}/>;
}

/** Whether a pull request is merged (its PullRequest entity). */
export function isMerged(pool: Pool, issueId: number): boolean {
  for (const pr of pool.model('PullRequest').by('issue_id', issueId)) if (pr.get('merged')) return true;
  return false;
}

/** The issue's state icon: Forgejo's open/closed/merged. */
export const StateIcon = observer(function StateIcon({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const state = issueState(useOverlay(), issue);
  const pull = issue.get('is_pull');
  const look = stateLook(state, pull, pull && isMerged(pool, issue.id));
  return <Hint label={look.label}><StateGlyph look={look}/></Hint>;
});

/** The workflow status: the status label's icon in its colour, else Forgejo's state icon. */
export const StatusCell = observer(function StatusCell({issue}: {issue: Entity<'Issue'>}) {
  const {status} = useLabelView(issue);
  if (!status) return <StateIcon issue={issue}/>;
  return (
    <Hint label={scopedValue(status.name)}><LabelIcon icon={statusIcon(status.name)} color={status.color}/></Hint>
  );
});

/** The priority label's icon (an empty slot without one, so titles line up). */
export const PriorityCell = observer(function PriorityCell({issue}: {issue: Entity<'Issue'>}) {
  const p = useLabelView(issue).priority;
  if (!p) return <span aria-hidden className="size-4 shrink-0"/>;
  return (
    <Hint label={`Priority: ${scopedValue(p.name)}`}><LabelIcon icon={priorityIcon(p.name)} color={p.color}/></Hint>
  );
});

/** The issue's other labels as chips (status and priority show as icons); at most `max`, then "+N". */
export const LabelsCell = observer(function LabelsCell({issue, max = 3}: {issue: Entity<'Issue'>; max?: number}) {
  const labels = useLabelView(issue).other;
  if (!labels.length) return null;
  const shown = labels.slice(0, max);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((l) => <LabelChip key={l.id} name={l.name} color={l.color}/>)}
      {labels.length > max && <span title={labels.slice(max).map((l) => l.name).join(', ')} className="text-sm text-fg-subtle tabular-nums">+{labels.length - max}</span>}
    </span>
  );
});

/** A user's display name and avatar from the pool (their profile may not be on this device). */
export function useUser(id: number): {name: string; login: string; avatar: string | undefined} {
  const u = usePool().model('User').get(id);
  const login = u?.get('login') ?? '';
  const full = u?.get('full_name') ?? '';
  const avatar = u?.get('avatar_url') ?? '';
  return {name: firstOf(full, login, `User ${String(id)}`), login, avatar: avatar === '' ? undefined : avatar};
}

export const UserAvatar = observer(function UserAvatar({id, size = 'sm'}: {id: number; size?: 'sm' | 'md' | 'lg'}) {
  const u = useUser(id);
  return <Avatar name={u.name} src={u.avatar} size={size}/>;
});

/** The assignees' avatars (at most three). */
export const AssigneesCell = observer(function AssigneesCell({issue}: {issue: Entity<'Issue'>}) {
  const ids = issueAssigneeIds(usePool(), useOverlay(), issue.id).sort((a, b) => a - b);
  if (!ids.length) return null;
  return (
    <AvatarGroup>
      {ids.slice(0, 3).map((id) => <UserAvatar key={id} id={id}/>)}
    </AvatarGroup>
  );
});

/** The milestone's title. */
export const MilestoneName = observer(function MilestoneName({issue}: {issue: Entity<'Issue'>}) {
  const id = issueMilestone(useOverlay(), issue);
  const title = usePool().model('Milestone').get(id)?.get('title');
  return title ? <span className="truncate">{title}</span> : null;
});

/** When the issue was last updated, compact ("3d"), with the full date on hover. */
export const UpdatedCell = observer(function UpdatedCell({issue}: {issue: Entity<'Issue'>}) {
  const at = issue.get('updated_at');
  return (
    <span title={`Updated ${fullDate(at)}`} className="w-10 text-right tabular-nums">{ago(at)}</span>
  );
});

export const TitleCell = observer(function TitleCell({issue}: {issue: Entity<'Issue'>}) {
  return <>{issue.get('title')}</>;
});

/** The first non-empty string. */
export function firstOf(...xs: string[]): string {
  return xs.find((x) => x !== '') ?? '';
}
