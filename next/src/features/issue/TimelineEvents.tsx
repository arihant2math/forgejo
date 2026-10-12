// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon as OcticonType} from '@primer/octicons-react';
import {
ArrowSwitchIcon,BookmarkIcon,CalendarIcon,
ClockIcon,CommentIcon,DuplicateIcon,EyeIcon,
GitBranchIcon,GitCommitIcon,GitMergeIcon,
GitPullRequestClosedIcon,GitPullRequestIcon,IssueClosedIcon,IssueReopenedIcon,LinkIcon,LockIcon,MilestoneIcon,PencilIcon,PersonAddIcon,PersonIcon,PinIcon,
PinSlashIcon,ProjectIcon,
SkipIcon,TagIcon,UnlockIcon,XCircleIcon
} from '@primer/octicons-react';
import {IssueLabelToken, Timeline as PrimerTimeline, type TimelineBadgeProps} from '@primer/react';
import {useParams} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {createElement, type ReactNode} from 'react';
import {RouterLink} from '../../app/routerLinks.tsx';
import {shortDate} from '../../app/time.ts';
import {textOfMarkup} from '../../app/trusted.ts';
import {count} from '../../app/words.ts';
import {Sha, summary} from '../../components/Sha.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {Entity} from '../../data/entity.ts';
import {viewMembers} from '../../intents/view.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {CodeLink} from '../code/nav.tsx';
import {useOverlay} from '../../intents/editing.ts';
import {usePool} from '../../app/store.ts';
import {UserAvatar} from '../issues/cells.tsx';
import {labelFill, labelKind, scopedValue, statusStage} from '../issues/labels.ts';
import {blocking, IssueLink} from './Sidebar.tsx';
import {type Row, Who} from './TimelineParts.tsx';

export type BadgeVariant = NonNullable<TimelineBadgeProps['variant']>;

interface EventLook {
  icon: OcticonType;
  text: ReactNode;
  /** State changes get GitHub's coloured badge; other events are condensed. */
  variant?: BadgeVariant | 'neutral';
}

export const EventItem = observer(function EventItem({comment: c, swapFrom, row}: {comment: Entity<'Comment'>; swapFrom?: number | undefined; row?: Row | undefined}) {
  const pool = usePool();
  const d = c.data as Comment;
  const look: EventLook = swapFrom !== undefined ? {icon: TagIcon, text: <LabelSwap from={swapFrom} to={d.label_id}/>} :
    d.type === 'close' || d.type === 'reopen' ? statusLook(d, statusFacts(pool, d), pool.model('Issue').get(d.issue_id)?.get('is_pull') === true) :
    describeEvent(d);
  const big = look.variant !== undefined;
  return (
    <PrimerTimeline.Item condensed={!big} {...row}>
      <PrimerTimeline.Badge {...look.variant && look.variant !== 'neutral' ? {variant: look.variant} : {}}>{createElement(look.icon)}</PrimerTimeline.Badge>
      <PrimerTimeline.Body>
        <span className="mr-1 inline-flex align-middle"><UserAvatar id={d.poster_id} size="sm" linked/></span>
        <Who id={d.poster_id} fallback={d.original_author}/> {look.text} <span className="text-muted"><TimeAgo at={d.created_at} variant="words"/></span>
      </PrimerTimeline.Body>
    </PrimerTimeline.Item>
  );
});

const LabelRef = observer(function LabelRef({id}: {id: number}) {
  const l = usePool().model('Label').get(id);
  const {owner, repo} = useParams({strict: false});
  if (!l) return <span>a label</span>;
  const kind = labelKind({name: l.get('name'), exclusive: l.get('exclusive')});
  const chip = <IssueLabelToken text={kind ? scopedValue(l.get('name')) : l.get('name')} fillColor={labelFill(l.get('color'))}/>;
  if (!owner || !repo) return chip;
  return <RouterLink to="/$owner/$repo/issues" params={{owner, repo}} search={{labels: String(id)}} muted>{chip}</RouterLink>;
});

const LabelEvent = observer(function LabelEvent({id, added}: {id: number; added: boolean}) {
  const l = usePool().model('Label').get(id);
  const kind = l && labelKind({name: l.get('name'), exclusive: l.get('exclusive')});
  if (!kind) return <>{added ? 'added' : 'removed'} <LabelRef id={id}/></>;
  return <>{added ? `set the ${kind} to` : `removed the ${kind}`} <LabelRef id={id}/></>;
});

const LabelSwap = observer(function LabelSwap({from, to}: {from: number; to: number}) {
  const l = usePool().model('Label').get(to);
  const kind = l ? labelKind({name: l.get('name'), exclusive: l.get('exclusive')}) : undefined;
  return <>changed the {kind ?? 'label'} from <LabelRef id={from}/> to <LabelRef id={to}/></>;
});

/** Forgejo encodes due dates as YYYY-MM-DD and changes as new|old. */
function deadlineText(d: Comment): ReactNode {
  const [next = '', old = ''] = d.body.split('|');
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? <span className="text-default">{shortDate(v)}</span> : null);
  switch (d.type) {
    case 'added_deadline':
      return <>set the due date to {date(next)}</>;
    case 'modified_deadline':
      return date(old) ? <>changed the due date from {date(old)} to {date(next)}</> : <>changed the due date to {date(next)}</>;
    default:
      return date(next) ? <>removed the due date {date(next)}</> : 'removed the due date';
  }
}

interface StatusFacts {
  sha: string | undefined;
  repo: {owner_name: string; name: string} | undefined;
  /** The pull request whose merge closed this. */
  pull: Entity<'PullRequest'> | undefined;
  message: string;
  reason: {duplicateOf?: number; notPlanned?: boolean} | undefined;
  original: Entity<'Issue'> | undefined;
}

/** Status changes keep the triggering SHA; older events can use the adjacent commit reference. */
function statusFacts(pool: ReturnType<typeof usePool>, d: Comment): StatusFacts {
  const comments = [...pool.model('Comment').by('issue_id', d.issue_id)].map((c) => c.data);
  const previous = comments.filter((c) => c.id < d.id).sort((a, b) => b.id - a.id)[0];
  const reference = comments.find((c) => c.type === 'commit_ref' && c.commit_id === d.commit_id) ??
    (previous?.type === 'commit_ref' && previous.poster_id === d.poster_id && previous.created_at === d.created_at ? previous : undefined);
  const sha = d.commit_id !== '' ? d.commit_id : reference?.commit_id;
  const repoId = d.ref_repo_id > 0 ? d.ref_repo_id : pool.model('Issue').get(d.issue_id)?.get('repo_id') ?? 0;
  const repo = pool.model('Repository').get(repoId)?.data;
  // Only a commit with no referencing pull request needs the scan for a merge commit.
  const pull = [...d.ref_is_pull ? pool.model('PullRequest').by('issue_id', d.ref_issue_id) : sha ? pool.model('PullRequest').all() : []]
    .find((p) => p.get('base_repo_id') === repoId && (d.ref_is_pull || p.get('merge_commit_sha') === sha));
  const message = reference?.body_html ? summary(textOfMarkup(reference.body_html).trim()) : '';
  const reason = d.type === 'close' && !sha && !d.ref_is_pull ? closeReason(pool, comments, d) : undefined;
  const original = reason?.duplicateOf === undefined ? undefined : [...pool.model('Issue').by('number', reason.duplicateOf)].find((i) => i.get('repo_id') === repoId);
  return {sha, repo, pull, message, reason, original};
}

function statusLook(d: Comment, facts: StatusFacts, isPull: boolean): EventLook {
  const text = <StatusText d={d} facts={facts}/>;
  if (d.type === 'reopen') return {icon: isPull ? GitPullRequestIcon : IssueReopenedIcon, variant: 'open', text};
  if (isPull) return {icon: GitPullRequestClosedIcon, variant: 'closed', text};
  if (facts.reason?.duplicateOf !== undefined) return {icon: DuplicateIcon, variant: 'neutral', text};
  if (facts.reason?.notPlanned) return {icon: SkipIcon, variant: 'neutral', text};
  return {icon: IssueClosedIcon, variant: 'done', text};
}

function StatusText({d, facts: {sha, repo, pull, message, reason, original}}: {d: Comment; facts: StatusFacts}) {
  if (reason?.duplicateOf !== undefined) {
    return <>closed this as a duplicate of {original ? <IssueRef id={original.id} from={d.issue_id}/> : `#${String(reason.duplicateOf)}`}</>;
  }
  if (reason?.notPlanned) return <>closed this as not planned</>;
  return <>{d.type === 'close' ? 'closed this' : 'reopened this'}{sha && repo && <> in <span><CodeLink owner={repo.owner_name} repo={repo.name} to={`commit/${sha}`}>
    <Sha sha={sha}/>{message ? ` ${message}` : ''}
  </CodeLink></span></>}{pull && <> in <IssueRef id={pull.get('issue_id')} from={d.issue_id}/></>}
  {!pull && d.ref_is_pull && d.ref_issue_id > 0 && <> in <IssueRef id={d.ref_issue_id} from={d.issue_id}/></>}</>;
}

export const StatusEvent = observer(function StatusEvent({d}: {d: Comment}) {
  return <StatusText d={d} facts={statusFacts(usePool(), d)}/>;
});

/** Maximum separation in milliseconds between a close and its reason event. */
const WITH_CLOSE = 60_000;

/** Infer close reasons from the closer's adjacent duplicate comment or canceled workflow status. */
function closeReason(pool: ReturnType<typeof usePool>, comments: Comment[], d: Comment): {duplicateOf?: number; notPlanned?: boolean} | undefined {
  const at = Date.parse(d.created_at);
  const near = comments.filter((c) => c.id !== d.id && c.poster_id === d.poster_id && Math.abs(Date.parse(c.created_at) - at) <= WITH_CLOSE);
  const said = near.filter((c) => c.type === 'comment' && c.id < d.id).sort((a, b) => b.id - a.id)[0];
  const dup = said ? /^\s*duplicate of #([1-9]\d{0,15})\b/i.exec(said.body) : null;
  if (dup) return {duplicateOf: Number(dup[1])};
  const canceled = near.some((c) => {
    if (c.type !== 'label' || c.body !== '1') return false;
    const l = pool.model('Label').get(c.label_id)?.data;
    return l !== undefined && labelKind(l) === 'status' && statusStage(scopedValue(l.name)) === 'canceled';
  });
  return canceled ? {notPlanned: true} : undefined;
}

const CommitRef = observer(function CommitRef({d}: {d: Comment}) {
  const pool = usePool();
  const r = pool.model('Repository').get(pool.model('Issue').get(d.issue_id)?.get('repo_id') ?? 0)?.data;
  const sha = d.commit_id;
  // Extract text, not markup, from Forgejo's rendered commit reference.
  const message = d.body_html ? summary(textOfMarkup(d.body_html).trim()) : '';
  if (!sha || !r) return <>referenced this in a commit</>;
  return (
    <>referenced this in <span><CodeLink owner={r.owner_name} repo={r.name} to={`commit/${sha}`}>
      <Sha sha={sha}/>{message ? ` ${message}` : ''}
    </CodeLink></span></>
  );
});

const PushEvent = observer(function PushEvent({d}: {d: Comment}) {
  const pool = usePool();
  const r = pool.model('Repository').get(pool.model('Issue').get(d.issue_id)?.get('repo_id') ?? 0)?.data;
  let push: {is_force_push?: unknown; commit_ids?: unknown} = {};
  try {
    push = JSON.parse(d.body) as typeof push;
  } catch {
    // Non-JSON event bodies fall back to plain text.
  }
  const ids = Array.isArray(push.commit_ids) ? push.commit_ids.filter((x): x is string => typeof x === 'string') : [];
  const link = (sha: string) => (r ?
    <span key={sha}><CodeLink owner={r.owner_name} repo={r.name} to={`commit/${sha}`}><Sha sha={sha}/></CodeLink></span> :
    <Sha key={sha} sha={sha}/>);
  if (push.is_force_push === true && ids.length === 2) return <>force-pushed from {link(ids[0] ?? '')} to {link(ids[1] ?? '')}</>;
  if (!ids.length) return <>pushed commits</>;
  const shown = ids.slice(0, 5);
  return (
    <>added {count(ids.length, 'commit', 'commits')}{' '}
      {shown.map((sha, i) => <span key={sha}>{i > 0 && ', '}{link(sha)}</span>)}{ids.length > shown.length && `, and ${String(ids.length - shown.length)} more`}</>
  );
});

const ProjectName = observer(function ProjectName({id}: {id: number}) {
  const pool = usePool();
  const title = pool.model('Project').get(id)?.get('title') ?? pool.model('ProjectRef').get(id)?.get('title');
  return <span className="font-semibold text-default">{title ?? 'a project'}</span>;
});

const TeamName = observer(function TeamName({id}: {id: number}) {
  const pool = usePool();
  const t = pool.model('Team').get(id);
  const org = t ? pool.model('User').get(t.get('org_id'))?.get('login') : undefined;
  return <span className="font-semibold text-default">{t ? `${org ? `${org}/` : ''}${t.get('name')}` : 'a team'}</span>;
});

/** Forgejo writes identical dependency events on both sides; infer direction from cached dependencies. */
const DependencyEvent = observer(function DependencyEvent({d}: {d: Comment}) {
  const pool = usePool();
  const overlay = useOverlay();
  const add = d.type === 'add_dependency';
  const other = <IssueRef id={d.dependent_issue_id} from={d.issue_id}/>;
  const blockedBy = viewMembers(pool, overlay, 'IssueDependency', d.issue_id).has(d.dependent_issue_id);
  const blocks = [...pool.model('IssueDependency').by('dependency_id', d.issue_id)].some((x) => x.get('issue_id') === d.dependent_issue_id) ||
    (blocking.get(d.issue_id) ?? []).includes(d.dependent_issue_id);
  // Removed dependencies have no cached direction; keep both sides' wording consistent.
  if (add && blockedBy) return <>added a dependency: blocked by {other}</>;
  if (add && blocks) return <>added a dependency: blocks {other}</>;
  return <>{add ? 'added a dependency with' : 'removed a dependency with'} {other}</>;
});

const MilestoneRef = observer(function MilestoneRef({id}: {id: number}) {
  const m = usePool().model('Milestone').get(id);
  const {owner, repo} = useParams({strict: false});
  const title = <span className="font-semibold text-default">{m?.get('title') ?? 'a milestone'}</span>;
  if (!m || !owner || !repo) return title;
  return <RouterLink to="/$owner/$repo/milestone/$index" params={{owner, repo, index: String(id)}} muted>{title}</RouterLink>;
});

const IssueRef = observer(function IssueRef({id, from}: {id: number; from: number}) {
  const repoId = usePool().model('Issue').get(from)?.get('repo_id') ?? 0;
  return <IssueLink id={id} repoId={repoId} missing="another issue" inline/>;
});

function describeEvent(d: Comment): EventLook {
  switch (d.type) {
    case 'merge_pull':
      return {icon: GitMergeIcon, variant: 'done', text: 'merged this'};
    case 'label':
      return {icon: TagIcon, text: <LabelEvent id={d.label_id} added={d.body === '1'}/>};
    case 'milestone':
      if (!d.milestone_id) return {icon: MilestoneIcon, text: <>removed this from <MilestoneRef id={d.old_milestone_id}/></>};
      return {icon: MilestoneIcon, text: <>{d.old_milestone_id ? 'moved this to' : 'added this to'} <MilestoneRef id={d.milestone_id}/></>};
    case 'assignees':
      if (d.assignee_id === d.poster_id) return {icon: PersonIcon, text: d.removed_assignee ? 'removed their assignment' : 'self-assigned this'};
      return {icon: d.removed_assignee ? PersonIcon : PersonAddIcon, text: <>{d.removed_assignee ? 'unassigned' : 'assigned'} <Who id={d.assignee_id}/></>};
    case 'review_request':
      return {icon: EyeIcon, text: <>{d.removed_assignee ? 'removed the review request for' : 'requested a review from'} {d.assignee_team_id ?
        <TeamName id={d.assignee_team_id}/> : <Who id={d.assignee_id} fallback="someone"/>}</>};
    case 'change_title':
      return {icon: PencilIcon, text: <>changed the title from <s>{d.old_title}</s> to <span className="text-default">{d.new_title}</span></>};
    case 'issue_ref':
    case 'comment_ref':
    case 'pull_ref':
    case 'change_issue_ref':
      return {icon: LinkIcon, text: <>referenced this from <IssueRef id={d.ref_issue_id} from={d.issue_id}/></>};
    case 'commit_ref':
      return {icon: GitCommitIcon, text: <CommitRef d={d}/>};
    case 'added_deadline':
    case 'modified_deadline':
    case 'removed_deadline':
      return {icon: CalendarIcon, text: deadlineText(d)};
    case 'add_dependency':
    case 'remove_dependency':
      return {icon: LinkIcon, text: <DependencyEvent d={d}/>};
    case 'lock':
      return {icon: LockIcon, text: d.body ? <>locked the conversation as <span className="text-default">{d.body.toLowerCase()}</span></> : 'locked the conversation'};
    case 'unlock':
      return {icon: UnlockIcon, text: 'unlocked the conversation'};
    case 'pin':
      return {icon: PinIcon, text: 'pinned this'};
    case 'unpin':
      return {icon: PinSlashIcon, text: 'unpinned this'};
    case 'delete_branch':
      return {icon: GitBranchIcon, text: <>deleted the branch <code>{d.old_ref}</code></>};
    case 'change_target_branch':
      return {icon: ArrowSwitchIcon, text: <>changed the target branch from <code>{d.old_ref}</code> to <code>{d.new_ref}</code></>};
    case 'pull_push':
      return {icon: GitPullRequestIcon, text: <PushEvent d={d}/>};
    case 'project':
      if (!d.project_id) return {icon: ProjectIcon, text: <>removed this from <ProjectName id={d.old_project_id}/></>};
      return {icon: ProjectIcon, text: <>{d.old_project_id ? 'moved this to' : 'added this to'} <ProjectName id={d.project_id}/></>};
    case 'project_board':
      return {icon: ProjectIcon, text: <>moved this to another column of <ProjectName id={d.project_id}/></>};
    case 'start_tracking':
    case 'stop_tracking':
    case 'add_time_manual':
    case 'cancel_tracking':
    case 'delete_time_manual':
      return {icon: ClockIcon, text: 'tracked time'};
    case 'pull_scheduled_merge':
      return {icon: GitMergeIcon, text: 'scheduled this to merge when checks succeed'};
    case 'pull_cancel_scheduled_merge':
      return {icon: XCircleIcon, text: 'canceled the scheduled merge'};
    case 'review':
      return {icon: EyeIcon, text: 'reviewed'};
    default:
      return {icon: d.type ? BookmarkIcon : CommentIcon, text: 'updated this'};
  }
}
