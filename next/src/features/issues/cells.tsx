// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observer leaves that show one aspect of an issue (PLAN §1 "one delta, one
// cell"): each reads only the fields it shows, through the overlay
// (intents/view.ts), so a delta or a local change re-renders that cell and
// nothing around it. Rows, the issue header and the sidebar share them.
// Hints are native titles (Hint): a Radix tooltip per cell would cost a
// mount per cell for every row scrolled into view.

import {compareStructural, computed, type IComputedValue} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ListCursor} from './flags.ts';
import type {IssueListModel} from './list.ts';
import {useApp} from '../../app/store.ts';
import {draftPrefix, wipPrefixes} from '../pull/draft.ts';
import {reach} from '../../app/online.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {editing} from '../../intents/session.ts';
import type {Overlay} from '../../intents/overlay.ts';
import {issueAssigneeIds, issueDeadline, issueLabelIds, issueMilestone, issuePinned, issueState, issueTitle} from '../../intents/view.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Avatar, AvatarGroup, Badge, Hint, Icon, LabelChip, LabelIcon, PendingIcon, TextLink} from '../../ui/index.ts';
import {Link} from '@tanstack/react-router';
import {ago, fullDate, shortDate} from './format.ts';
import {poolHead} from '../../code/pull.ts';
import {checksOf} from '../pull/checks.ts';
import {kindRank, labelKind, scopedValue, statusStage, type StatusStage} from './labels.ts';
import {repoLabels} from './candidates.ts';
import {CircleIcon, CheckCircleIcon, IssueClosedIcon, IssueDraftIcon, IssueOpenedIcon, DotFillIcon, CodeReviewIcon, XCircleIcon, GitMergeIcon, GitPullRequestIcon, CalendarIcon, GitPullRequestClosedIcon, StopIcon, PinIcon, GraphBarVerticalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType, IconProps as OcticonProps} from '@primer/octicons-react';

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

const STAGE_ICONS: Record<StatusStage, OcticonType> = {
  backlog: IssueDraftIcon, todo: CircleIcon, started: DotFillIcon, review: CodeReviewIcon, done: IssueClosedIcon, canceled: XCircleIcon,
};

/** Whether a status label means the work ended (done, canceled). */
export function terminal(name: string): boolean {
  const stage = statusStage(scopedValue(name));
  return stage === 'done' || stage === 'canceled';
}

export function statusIcon(name: string): OcticonType {
  const stage = statusStage(scopedValue(name));
  return stage ? STAGE_ICONS[stage] : CircleIcon;
}

/**
 * Priority as bars (Linear's look): the filled bars say the level, the others stay faint, so Low is one bar
 * of three rather than lucide's lone short bar (which reads as a stray mark at 16 px).
 */
function bars(name: string, filled: number): OcticonType {
  // Drawn like an octicon (a 16 px grid, currentColor), so it sits wherever an octicon does.
  function Bars({size = 16, className, 'aria-label': label}: OcticonProps) {
    const px = typeof size === 'number' ? size : size === 'small' ? 16 : size === 'medium' ? 32 : 64;
    return (
      <svg viewBox="0 0 24 24" width={px} height={px} className={className} fill="currentColor" role={label ? 'img' : undefined}
        aria-label={label} aria-hidden={label ? undefined : true}>
        {[0, 1, 2].map((i) => <rect key={i} x={3 + i * 7} y={14 - i * 5} width={4} height={6 + i * 5} rx={1} opacity={i < filled ? undefined : 0.3}/>)}
      </svg>
    );
  }
  Bars.displayName = name;
  return Bars;
}

/** No priority: the three bars, all faint (lucide's SignalZero is a lone dot, a stray mark in a menu). */
export const NoPriorityIcon = bars('priority-none', 0);

const PRIORITY_ICONS: OcticonType[] = [StopIcon, bars('priority-high', 3), bars('priority-medium', 2), bars('priority-low', 1), NoPriorityIcon];

export function priorityIcon(name: string): OcticonType {
  return PRIORITY_ICONS[Math.min(4, Math.max(0, Math.round(kindRank('priority', name))))] ?? GraphBarVerticalIcon;
}

interface StateLook {
  icon: OcticonType;
  tone: keyof typeof STATE_TONES;
  label: string;
}

const STATE_TONES = {open: 'text-success', merged: 'text-done', done: 'text-done', closed: 'text-danger'} as const;

/** Open/closed/merged as Forgejo shows it, without workflow labels. */
export function stateLook(state: string, pull: boolean, merged: boolean): StateLook {
  if (pull) {
    if (merged) return {icon: GitMergeIcon, tone: 'merged', label: 'Merged'};
    return state === 'open' ? {icon: GitPullRequestIcon, tone: 'open', label: 'Open'} : {icon: GitPullRequestClosedIcon, tone: 'closed', label: 'Closed'};
  }
  return state === 'open' ? {icon: IssueOpenedIcon, tone: 'open', label: 'Open'} : {icon: CheckCircleIcon, tone: 'done', label: 'Closed'};
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

/**
 * The workflow status: the status label's icon in its colour, else Forgejo's state icon — also for a
 * closed issue whose status label still says it is in progress (the state wins: closed is closed).
 */
export const StatusCell = observer(function StatusCell({issue}: {issue: Entity<'Issue'>}) {
  const {status} = useLabelView(issue);
  const open = issueState(useOverlay(), issue) === 'open';
  // A pull request always reads as one (open, draft, merged, closed): its review and checks say where it is.
  if (!status || issue.get('is_pull') || (!open && !terminal(status.name))) return <StateIcon issue={issue}/>;
  return (
    <Hint label={scopedValue(status.name)}><LabelIcon icon={statusIcon(status.name)} color={status.color}/></Hint>
  );
});

/** Whether a repository works with status labels (then an open issue without one has "No status" yet). */
export function usesStatuses(pool: Pool, repoId: number): boolean {
  return repoLabels(pool, repoId).some((l) => labelKind(l) === 'status');
}

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

/**
 * A person's name, a link to their page here (the owner page) when their login is known; `fallback` for
 * someone not on this device (an imported comment's original author).
 */
export const UserName = observer(function UserName({id, fallback = 'Someone'}: {id: number; fallback?: string}) {
  const u = useUser(id);
  if (!id || !u.login) return <span className="font-medium text-fg">{id ? u.name : fallback}</span>;
  return <span className="font-medium"><TextLink wrap><Link to="/$owner" params={{owner: u.login}} activeOptions={{exact: true}}>{u.name}</Link></TextLink></span>;
});

export const UserAvatar = observer(function UserAvatar({id, size = 'sm', linked = false}: {id: number; size?: 'sm' | 'md' | 'lg'; linked?: boolean}) {
  const u = useUser(id);
  const avatar = <Avatar name={u.name} src={u.avatar} size={size}/>;
  return linked && u.login ? <Link to="/$owner" params={{owner: u.login}} aria-label={`Profile of ${u.login}`}>{avatar}</Link> : avatar;
});

/**
 * The assignees' avatars (at most three, then "+N"), each named on hover like the row's other icons (an
 * identicon alone says nobody's name); the hidden ones are named on the count's hover.
 */
export const AssigneesCell = observer(function AssigneesCell({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const ids = issueAssigneeIds(pool, useOverlay(), issue.id).sort((a, b) => a - b);
  if (!ids.length) return null;
  const rest = ids.slice(3);
  return (
    <AvatarGroup>
      {ids.slice(0, 3).map((id) => <AssigneeAvatar key={id} id={id}/>)}
      {rest.length > 0 && (
        <span title={`Also assigned: ${rest.map((id) => userLabel(pool, id)).join(', ')}`} className="text-sm text-fg-subtle tabular-nums">+{rest.length}</span>
      )}
    </AvatarGroup>
  );
});

/** A person's name for a hint ("Alice Nakamura (alice)"). */
function userLabel(pool: Pool, id: number): string {
  const u = pool.model('User').get(id);
  const login = u?.get('login') ?? '';
  const full = u?.get('full_name') ?? '';
  if (full && login && full !== login) return `${full} (${login})`;
  return firstOf(full, login, `User ${String(id)}`);
}

/** One assignee's avatar, named on hover. */
const AssigneeAvatar = observer(function AssigneeAvatar({id}: {id: number}) {
  const name = userLabel(usePool(), id);
  return <span title={`Assignee: ${name}`} className="flex shrink-0"><UserAvatar id={id}/></span>;
});

/**
 * Who opened the issue or pull request (the classic list's "opened … by bob"): their login, named in full on
 * hover; the row's accessible name reads "by bob".
 */
export const AuthorCell = observer(function AuthorCell({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const id = issue.get('poster_id');
  const login = pool.model('User').get(id)?.get('login');
  if (!id || !login) return null;
  return (
    <span title={`Opened by ${userLabel(pool, id)}`} className="max-w-28 truncate whitespace-nowrap">
      <span className="sr-only">by </span>{login}
    </span>
  );
});

/** The milestone's title. */
export const MilestoneName = observer(function MilestoneName({issue}: {issue: Entity<'Issue'>}) {
  const id = issueMilestone(useOverlay(), issue);
  const title = usePool().model('Milestone').get(id)?.get('title');
  return title ? <span className="truncate">{title}</span> : null;
});

/** The due date in a row ("Oct 1"), in the danger tone when it has passed and the issue is open; nothing without one. */
export const DueCell = observer(function DueCell({issue}: {issue: Entity<'Issue'>}) {
  const overlay = useOverlay();
  const due = issueDeadline(overlay, issue);
  if (!due) return null;
  const late = issueState(overlay, issue) === 'open' && Date.parse(due) < Date.now();
  return (
    <span title={`Due ${fullDate(due)}${late ? ' (overdue)' : ''}`} className={late ? 'flex items-center gap-1 whitespace-nowrap text-danger' : 'flex items-center gap-1 whitespace-nowrap'}>
      <CalendarIcon size={12} className="shrink-0"/>{shortDate(due)}
    </span>
  );
});

/** Forgejo's default work-in-progress title prefixes (setting.Repository.PullRequest.WorkInProgressPrefixes). */
/** Whether a pull request is a draft (its title starts with a work-in-progress prefix, as Forgejo decides). */
export function isDraft(title: string, prefixes: readonly string[] = ['WIP:', '[WIP]']): boolean {
  return draftPrefix(title, prefixes) !== undefined;
}

const CHECK_ICON = {success: CheckCircleIcon, failure: XCircleIcon, pending: DotFillIcon} as const;
const CHECK_TONE = {success: 'text-success', failure: 'text-danger', pending: 'text-warning'} as const;
const CHECK_LABEL = {success: 'Checks passed', failure: 'Checks failed', pending: 'Checks running'} as const;

/**
 * A pull request's state in a row: draft, its checks at the head (as the merge box sums them), and the reviews'
 * verdict (changes requested wins over approved; each reviewer's latest review counts). Nothing for an issue.
 */
export const PullStateCell = observer(function PullStateCell({issue}: {issue: Entity<'Issue'>}) {
  const pool = usePool();
  const overlay = useOverlay();
  const prefixes = wipPrefixes(useApp().config);
  if (!issue.get('is_pull')) return null;
  const draft = isDraft(issueTitle(overlay, issue), prefixes);
  const pr = [...pool.model('PullRequest').by('issue_id', issue.id)][0]?.data;
  const head = pr && !pr.merged ? poolHead(pool, pr) : undefined;
  const checks = pr && head ? checksOf(pool, pr, head).summary : 'none';
  // The verdicts come with the repository (ReviewVerdict), not only once the pull request was opened (its Reviews).
  const latest = new Map<number, string>();
  for (const r of [...pool.model('ReviewVerdict').by('issue_id', issue.id)].map((e) => e.data).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!r.reviewer_id || r.dismissed) continue;
    latest.set(r.reviewer_id, r.state);
  }
  const verdicts = [...latest.values()];
  const review = verdicts.includes('REQUEST_CHANGES') ? 'changes' : verdicts.includes('APPROVED') ? 'approved' : undefined;
  return (
    <>
      {draft && <Badge>Draft</Badge>}
      {review === 'changes' && <Badge tone="danger">Changes requested</Badge>}
      {review === 'approved' && <Badge tone="success">Approved</Badge>}
      {checks !== 'none' && <Hint label={CHECK_LABEL[checks]}><Icon icon={CHECK_ICON[checks]} size="sm" className={CHECK_TONE[checks]}/></Hint>}
    </>
  );
});

/** A pinned issue's mark in a row (pinned to its repository's list). */
export const PinCell = observer(function PinCell({issue}: {issue: Entity<'Issue'>}) {
  return issuePinned(useOverlay(), issue) ? <Hint label="Pinned"><PinIcon size={12} className="shrink-0"/></Hint> : null;
});

/** When the issue was last updated, compact ("3d"), with the full date on hover. */
export const UpdatedCell = observer(function UpdatedCell({issue}: {issue: Entity<'Issue'>}) {
  return <AgoCell at={issue.get('updated_at')} label="Updated"/>;
});

/**
 * An issue's reference in a row's trailing slot ("acme/atlas#12"); on a phone the number only, so the title
 * keeps its room.
 */
export function RefCell({repo, number}: {repo: string; number: number | undefined}) {
  const ref = number === undefined ? '' : `#${String(number)}`;
  // At phone width the owner goes and the repository's name stays (truncated): atlas#12 and design-system#12 must
  // still look different (QA round 2).
  const slash = repo.indexOf('/') + 1;
  return (
    <span title={repo ? `${repo}${ref}` : undefined} className="flex min-w-0 tabular-nums">
      {repo && <span className="max-md:hidden">{repo.slice(0, slash)}</span>}
      {repo && <span className="truncate max-md:max-w-24">{repo.slice(slash)}</span>}
      <span className="shrink-0">{ref}</span>
    </span>
  );
}

/** A compact time in a row's trailing slot ("3d"), the full date on hover. */
export function AgoCell({at, label}: {at: string; label?: string}) {
  return <span title={label ? `${label} ${fullDate(at)}` : fullDate(at)} className="w-12 whitespace-nowrap text-right tabular-nums">{ago(at)}</span>;
}

export const TitleCell = observer(function TitleCell({issue}: {issue: Entity<'Issue'>}) {
  return <>{issueTitle(useOverlay(), issue)}</>;
});

/**
 * The pending badge (PLAN §5.4): changes to this issue that Forgejo does not
 * have yet. Observes the issue's pending count only.
 */
export const PendingCell = observer(function PendingCell({issueId}: {issueId: number}) {
  const app = useApp();
  const n = editing(app).intents.pendingOn(issueId);
  if (!n) return null;
  return <PendingIcon label={`${String(n)} ${n === 1 ? 'change' : 'changes'} not synced yet`} now={reach(app.session?.data.status.connection) !== 'online'}/>;
});

/** How many rows of a list are selected (X), with the way out; nothing without a selection (lists, the inbox). */
export const SelectionCount = observer(function SelectionCount({cursor}: {cursor: ListCursor}) {
  const n = cursor.selected.size;
  return n > 0 ? <Badge tone="accent">{n} selected · Esc clears</Badge> : null;
});

/** How many rows a narrowed list shows (a search or a filter is in effect): the list itself says nothing of it. */
export const ResultCount = observer(function ResultCount({model}: {model: IssueListModel}) {
  const f = model.query.filter;
  const narrowed = f.q !== undefined || f.labels.length > 0 || f.assignee !== undefined || f.poster !== undefined || f.milestone !== undefined ||
    f.status !== undefined || f.priority !== undefined || f.label !== undefined || f.repo !== undefined;
  if (!narrowed) return null;
  const n = model.result.get().ids.length;
  // Plain text: a chip beside the state buttons read as one more of them, pressed (QA verify3).
  return <span className="text-sm whitespace-nowrap text-fg-subtle tabular-nums">{n === 1 ? '1 result' : `${String(n)} results`}</span>;
});

/** The first non-empty string. */
export function firstOf(...xs: string[]): string {
  return xs.find((x) => x !== '') ?? '';
}
