// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An issue's timeline from its lazy group (issue:{id}, B6): comments and
// reviews as cards with their rendered markdown and reactions, everything
// else (closes, labels, assignments, references, …) as one compact line.
// Long timelines are virtualized (Virtuoso) against the page's scroll
// container; short ones render plainly. Every item is an observer of its
// own entity.

import {
  ArrowRightLeft, Bookmark, CircleCheck, CircleDot, Clock, Eye, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequestArrow, Link2,
  Lock, LockOpen, MessageSquare, Milestone, Pencil, Pin, PinOff, SquareKanban, Tag, UserCheck, UserMinus, UserPlus, XCircle,
} from 'lucide-react';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {lazy, type ReactNode, Suspense, useState} from 'react';
import type {Entity} from '../../data/entity.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {Badge, type BadgeTone, Code, Icon, LabelChip, LabelIcon, type LucideIcon} from '../../ui/index.ts';
import {useApp} from '../../app/store.ts';
import {DELETED} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import {issueComments} from '../../intents/view.ts';
import {firstOf, priorityIcon, statusIcon, useOverlay, usePool, UserAvatar, useUser} from '../issues/cells.tsx';
import {labelKind, scopedValue} from '../issues/labels.ts';
import {agoWords, fullDate} from '../issues/format.ts';
import {CommentActions, CommentBody} from './Editing.tsx';
import {Markdown} from './Markdown.tsx';
import {Reactions} from './Reactions.tsx';

/** Above this many items the timeline is virtualized. */
const VIRTUALIZE_FROM = 50;

type Item = {kind: 'comment'; id: number; at: string} | {kind: 'review'; id: number; at: string};

/** The issue's timeline items in order (observes membership of its comments and reviews). */
function useItems(issueId: number): Item[] {
  const pool = usePool();
  const app = useApp();
  const {overlay, intents} = editing(app);
  // The pool's comments and the ones posted here not synced yet (a deleted one hides itself: CommentBody).
  const comments = issueComments(pool, overlay, issueId, intents.remapped);
  const reviews = pool.model('Review').by('issue_id', issueId);
  return untracked(() => {
    const out: Item[] = [];
    for (const c of comments) {
      // A review's own comment (type review) and its code comments show in the review's card.
      if ((c.data.type === 'code' || c.data.type === 'review') && c.data.review_id) continue;
      out.push({kind: 'comment', id: c.id, at: c.data.created_at});
    }
    for (const r of reviews) {
      const st = r.data.state;
      if (st === 'PENDING' || st === 'REQUEST_REVIEW') continue;
      out.push({kind: 'review', id: r.id, at: r.data.created_at});
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  });
}

// Loaded only for a long timeline (most are short: plain rows).
const Virtuoso = lazy(() => import('react-virtuoso').then((m) => ({default: m.Virtuoso as typeof m.Virtuoso<Item>})));

export const Timeline = observer(function Timeline({issueId, scroller}: {issueId: number; scroller: HTMLDivElement | null}) {
  const items = useItems(issueId);
  if (!items.length) return null;
  const render = (it: Item) => (it.kind === 'comment' ? <CommentItem id={it.id}/> : <ReviewItem id={it.id}/>);
  return (
    <section aria-label="Activity" className="flex flex-col">
      {items.length < VIRTUALIZE_FROM || !scroller ?
        items.map((it) => <div key={`${it.kind}${String(it.id)}`}>{render(it)}</div>) :
        <Suspense fallback={items.slice(0, 20).map((it) => <div key={`${it.kind}${String(it.id)}`}>{render(it)}</div>)}>
          <Virtuoso customScrollParent={scroller} data={items} increaseViewportBy={600}
            computeItemKey={(_, it) => `${it.kind}${String(it.id)}`} itemContent={(_, it) => render(it)}/>
        </Suspense>}
    </section>
  );
});

function Who({id, fallback}: {id: number; fallback?: string}) {
  const u = useUser(id);
  return <span className="font-medium text-fg">{id ? u.name : firstOf(fallback ?? '', 'Someone')}</span>;
}

/** When, compact, with the full date on hover. */
function When({at}: {at: string}) {
  return <time dateTime={at} title={fullDate(at)} className="text-fg-subtle">{agoWords(at)}</time>;
}

/** A card: comments and reviews. */
function Card({poster, original, at, badge, children, footer}: {poster: number; original: string; at: string; badge?: ReactNode; children: ReactNode; footer?: ReactNode}) {
  return (
    <article className="flex gap-3 py-3">
      <UserAvatar id={poster} size="lg"/>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex flex-wrap items-center gap-x-2 text-base">
          <Who id={poster} fallback={original}/>
          <When at={at}/>
          {badge}
        </header>
        {children}
        {footer}
      </div>
    </article>
  );
}

const CommentItem = observer(function CommentItem({id}: {id: number}) {
  const pool = usePool();
  const overlay = useOverlay();
  const c = pool.model('Comment').get(id) ?? overlay.createdEntity('Comment', id) as Entity<'Comment'> | undefined;
  if (!c) return null;
  const type = c.get('type');
  if (type === 'comment' || type === 'code' || type === 'dismiss_review') {
    if (overlay.field('Comment', id, DELETED)) return null;
    return <CommentCard c={c} type={type}/>;
  }
  return <EventLine comment={c}/>;
});

/** A comment's card: its header (with the viewer's actions), its body or editor, its reactions. */
function CommentCard({c, type}: {c: Entity<'Comment'>; type: string}) {
  const [edit, setEdit] = useState(false);
  return (
    <Card poster={c.get('poster_id')} original={c.get('original_author')} at={c.get('created_at')}
      badge={<>
        {type === 'dismiss_review' ? <Badge tone="warning">dismissed a review</Badge> : type === 'code' ? <Badge>{c.get('path')}</Badge> : undefined}
        {c.id > 0 && <CommentActions c={c} onEdit={() => {
          setEdit(true);
        }}/>}
      </>}
      footer={<Reactions issueId={c.get('issue_id')} commentId={c.id}/>}>
      <CommentBody c={c} edit={edit} onEditDone={() => {
        setEdit(false);
      }}/>
    </Card>
  );
}

const REVIEW_LOOK: Record<string, {tone: BadgeTone; text: string}> = {
  APPROVED: {tone: 'success', text: 'approved'},
  REQUEST_CHANGES: {tone: 'danger', text: 'requested changes'},
  COMMENT: {tone: 'neutral', text: 'reviewed'},
};

const ReviewItem = observer(function ReviewItem({id}: {id: number}) {
  const pool = usePool();
  const r = pool.model('Review').get(id);
  if (!r) return null;
  const look = REVIEW_LOOK[r.get('state')] ?? {tone: 'neutral' as const, text: 'reviewed'};
  const html = r.get('body_html');
  const codes = [...pool.model('Comment').by('review_id', id)].filter((c) => c.get('type') === 'code');
  return (
    <Card poster={r.get('reviewer_id')} original={r.get('original_author')} at={r.get('created_at')}
      badge={<Badge tone={look.tone}>{look.text}{r.get('stale') ? ' · outdated' : ''}{r.get('dismissed') ? ' · dismissed' : ''}</Badge>}>
      {html && <Markdown html={html}/>}
      {codes.map((c) => <CodeComment key={c.id} c={c}/>)}
    </Card>
  );
});

const CodeComment = observer(function CodeComment({c}: {c: Entity<'Comment'>}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-sm text-fg-muted"><Who id={c.get('poster_id')} fallback={c.get('original_author')}/> on <Code>{c.get('path')}</Code> line {Math.abs(c.get('line'))}</span>
      <Markdown html={c.get('body_html')}/>
    </div>
  );
});

/** One line for an event, by comment type (models/issues/comment.go commentStrings). */
const EventLine = observer(function EventLine({comment: c}: {comment: Entity<'Comment'>}) {
  const d = c.data as Comment;
  const ev = describeEvent(d);
  return (
    <div className="flex min-h-control items-center gap-3 py-1 text-base text-fg-muted">
      <span className="flex size-6 shrink-0 items-center justify-center"><Icon icon={ev.icon} size="sm"/></span>
      <span className="min-w-0">
        <Who id={d.poster_id} fallback={d.original_author}/> {ev.text} <When at={d.created_at}/>
      </span>
    </div>
  );
});

const LabelRef = observer(function LabelRef({id}: {id: number}) {
  const l = usePool().model('Label').get(id);
  if (!l) return <span>a label</span>;
  const kind = labelKind({name: l.get('name'), exclusive: l.get('exclusive')});
  // A status or priority label reads as such ("In progress" with its icon), as in the list and the sidebar.
  if (kind) {
    return (
      <span className="inline-flex items-center gap-1 align-middle text-fg">
        <LabelIcon icon={kind === 'status' ? statusIcon(l.get('name')) : priorityIcon(l.get('name'))} color={l.get('color')} size="sm"/>
        {scopedValue(l.get('name'))}
      </span>
    );
  }
  return <LabelChip name={l.get('name')} color={l.get('color')}/>;
});

const MilestoneRef = observer(function MilestoneRef({id}: {id: number}) {
  const m = usePool().model('Milestone').get(id);
  return <span className="font-medium text-fg">{m?.get('title') ?? 'a milestone'}</span>;
});

const IssueRef = observer(function IssueRef({id}: {id: number}) {
  const pool = usePool();
  const i = pool.model('Issue').get(id);
  if (!i) return <span>another issue</span>;
  return <span className="text-fg">#{i.get('number')} {i.get('title')}</span>;
});

function describeEvent(d: Comment): {icon: LucideIcon; text: ReactNode} {
  switch (d.type) {
    case 'close':
      return {icon: CircleCheck, text: 'closed this'};
    case 'reopen':
      return {icon: CircleDot, text: 'reopened this'};
    case 'merge_pull':
      return {icon: GitMerge, text: 'merged this'};
    case 'label':
      return {icon: Tag, text: <>{d.body === '1' ? 'added' : 'removed'} <LabelRef id={d.label_id}/></>};
    case 'milestone':
      if (!d.milestone_id) return {icon: Milestone, text: <>removed this from <MilestoneRef id={d.old_milestone_id}/></>};
      return {icon: Milestone, text: <>{d.old_milestone_id ? 'moved this to' : 'added this to'} <MilestoneRef id={d.milestone_id}/></>};
    case 'assignees':
      if (d.assignee_id === d.poster_id) return {icon: d.removed_assignee ? UserMinus : UserCheck, text: d.removed_assignee ? 'removed their assignment' : 'self-assigned this'};
      return {icon: d.removed_assignee ? UserMinus : UserPlus, text: <>{d.removed_assignee ? 'unassigned' : 'assigned'} <Who id={d.assignee_id}/></>};
    case 'review_request':
      return {icon: Eye, text: d.removed_assignee ? 'removed a review request' : <>requested a review from <Who id={d.assignee_id} fallback="a team"/></>};
    case 'change_title':
      return {icon: Pencil, text: <>changed the title from <s>{d.old_title}</s> to <span className="text-fg">{d.new_title}</span></>};
    case 'issue_ref':
    case 'comment_ref':
    case 'pull_ref':
    case 'change_issue_ref':
      return {icon: Link2, text: <>referenced this from <IssueRef id={d.ref_issue_id}/></>};
    case 'commit_ref':
      return {icon: GitCommitHorizontal, text: 'referenced this in a commit'};
    case 'added_deadline':
    case 'modified_deadline':
    case 'removed_deadline':
      return {icon: Clock, text: d.type === 'removed_deadline' ? 'removed the due date' : 'changed the due date'};
    case 'add_dependency':
      return {icon: Link2, text: <>added a dependency on <IssueRef id={d.dependent_issue_id}/></>};
    case 'remove_dependency':
      return {icon: Link2, text: <>removed a dependency on <IssueRef id={d.dependent_issue_id}/></>};
    case 'lock':
      return {icon: Lock, text: 'locked the conversation'};
    case 'unlock':
      return {icon: LockOpen, text: 'unlocked the conversation'};
    case 'pin':
      return {icon: Pin, text: 'pinned this'};
    case 'unpin':
      return {icon: PinOff, text: 'unpinned this'};
    case 'delete_branch':
      return {icon: GitBranch, text: <>deleted the branch <Code>{d.old_ref}</Code></>};
    case 'change_target_branch':
      return {icon: ArrowRightLeft, text: <>changed the target branch from <Code>{d.old_ref}</Code> to <Code>{d.new_ref}</Code></>};
    case 'pull_push':
      return {icon: GitPullRequestArrow, text: 'pushed commits'};
    case 'project':
    case 'project_board':
      return {icon: SquareKanban, text: 'changed the project'};
    case 'start_tracking':
    case 'stop_tracking':
    case 'add_time_manual':
    case 'cancel_tracking':
    case 'delete_time_manual':
      return {icon: Clock, text: 'tracked time'};
    case 'pull_scheduled_merge':
      return {icon: GitMerge, text: 'scheduled this to merge when checks succeed'};
    case 'pull_cancel_scheduled_merge':
      return {icon: XCircle, text: 'canceled the scheduled merge'};
    case 'review':
      return {icon: Eye, text: 'reviewed'};
    default:
      return {icon: d.type ? Bookmark : MessageSquare, text: 'updated this'};
  }
}

