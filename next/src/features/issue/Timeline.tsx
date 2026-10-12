// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Long timelines are virtualized against the page scroller; each item observes its own entity.

import {SuggestionCard} from '../pull/Suggestion.tsx';
import {suggestionOnly} from '../pull/suggestions.ts';
import {pullOf} from '../../code/pull.ts';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {createElement, createContext, type CSSProperties, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {Entity} from '../../data/entity.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {clsx} from 'clsx';
import {useParams, useRouterState} from '@tanstack/react-router';
import {commentAnchor} from '../../code/anchor.ts';
import {submitReview} from '../../code/review.ts';
import {uuid} from '../../intents/intents.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {Sha, summary} from '../../components/Sha.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {hunkFile} from '../../code/hunk.ts';
import {DiffSnippet} from '../../code/DiffSnippet.tsx';
import {CodeLink} from '../code/nav.tsx';
import {useScrollMargin} from '../code/Lines.tsx';
import {pageListRect} from '../../app/shell/Frame.tsx';
import {useApp} from '../../app/store.ts';
import {DELETED} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import {commentBody, issueBody, issueComments, viewMembers} from '../../intents/view.ts';
import {firstOf, labelColor, useOverlay, usePool, UserAvatar, UserName} from '../issues/cells.tsx';
import {labelKind, scopedValue, statusStage} from '../issues/labels.ts';
import {fullDate, shortDate} from '../../app/time.ts';
import {BodySection, CardMenu, CommentActions, CommentBody, useBodyEdit} from './Editing.tsx';
import {Markdown} from './Markdown.tsx';
import {afterPaint} from '../../app/paint.ts';
import {textOfMarkup} from '../../app/trusted.ts';
import {Reactions} from './Reactions.tsx';
import {blocking, IssueLink} from './Sidebar.tsx';
import {conversationReplies, conversationRoot, replyOnlyReview, replyRoot, ResolveButton, ResolvedFold, useResolver} from '../pull/resolve.tsx';
import {ArrowSwitchIcon, BookmarkIcon, CalendarIcon, CheckIcon, ClockIcon, CommentIcon, DuplicateIcon, EyeIcon, FileDiffIcon, GitBranchIcon, GitCommitIcon, GitMergeIcon,
  GitPullRequestClosedIcon, GitPullRequestIcon, IssueClosedIcon, IssueReopenedIcon, LinkIcon, LockIcon, MilestoneIcon, PencilIcon, PersonAddIcon, PersonIcon, PinIcon,
  PinSlashIcon, ProjectIcon, ReplyIcon, SkipIcon, TagIcon, UnlockIcon, XCircleIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, IssueLabelToken, Label, Timeline as PrimerTimeline, type TimelineBadgeProps} from '@primer/react';
import {FeatureFlags} from '@primer/react/experimental';
import {RouterLink} from '../../app/routerLinks.tsx';

const VIRTUALIZE_FROM = 50;

/** `swapFrom`: a label event that replaced this label (the same field: a status changed from one to another). */
type Item = {kind: 'comment'; id: number; at: string; swapFrom?: number} | {kind: 'review'; id: number; at: string};

const itemKey = (it: Item) => `${it.kind}${String(it.id)}`;

/** A virtual row's measuring ref and position (computed, so a style), set on the timeline item itself so the list holds only its items. */
interface Row {
  ref: (el: Element | null) => void;
  'data-index': number;
  className: string;
  style: CSSProperties;
}

const LIST_SEMANTICS = {primer_react_timeline_list_semantics: true};

/** Primer's Timeline as a list of items (`ol` of `li`); Primer keeps that behind a flag that is off by default. */
function TimelineList({clipSidebar, children}: {clipSidebar?: 'start'; children: ReactNode}) {
  return <FeatureFlags flags={LIST_SEMANTICS}><PrimerTimeline {...clipSidebar ? {clipSidebar} : {}}>{children}</PrimerTimeline></FeatureFlags>;
}

function useItems(issueId: number): Item[] {
  const pool = usePool();
  const app = useApp();
  const {overlay, intents} = editing(app);
  const comments = issueComments(pool, overlay, issueId, intents.remapped);
  const reviews = pool.model('Review').by('issue_id', issueId);
  // A deleted comment has no item: no empty list entry, no unmeasured virtual row.
  const live = comments.filter((c) => overlay.field('Comment', c.id, DELETED) === undefined);
  return untracked(() => {
    const out: Item[] = [];
    for (const c of live) {
      // Review cards own their summary and code comments; avoid duplicate entries.
      if ((c.data.type === 'code' || c.data.type === 'review') && c.data.review_id) continue;
      out.push({kind: 'comment', id: c.id, at: c.data.created_at});
    }
    for (const r of reviews) {
      const st = r.data.state;
      if (st === 'PENDING' || st === 'REQUEST_REVIEW') continue;
      // Forgejo stores thread replies as reviews; render them only in their parent thread.
      if (replyOnlyReview(pool, r.id)) continue;
      out.push({kind: 'review', id: r.id, at: r.data.created_at});
    }
    out.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    return mergeSwaps(pool, out);
  });
}

/** Forgejo emits label removal and addition separately; coalesce a same-author status or priority swap. */
function mergeSwaps(pool: ReturnType<typeof usePool>, items: Item[]): Item[] {
  const out: Item[] = [];
  const event = (it: Item | undefined) => (it?.kind === 'comment' && it.swapFrom === undefined ? pool.model('Comment').get(it.id)?.data : undefined);
  const kindOf = (labelId: number) => {
    const l = pool.model('Label').get(labelId)?.data;
    return l ? labelKind(l) : undefined;
  };
  for (const it of items) {
    const a = event(out.at(-1));
    const b = event(it);
    if (a?.type === 'label' && b?.type === 'label' && a.poster_id === b.poster_id && (a.body === '1') !== (b.body === '1') &&
      Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at)) < 60_000) {
      const kind = kindOf(a.label_id);
      if (kind && kind === kindOf(b.label_id)) {
        const [removed, added] = a.body === '1' ? [b, a] : [a, b];
        out[out.length - 1] = {kind: 'comment', id: added.id, at: it.at, swapFrom: removed.label_id};
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/** Limit first-paint work: rendering many comment bodies can delay a slow device by a frame. */
const FIRST_PAINT = 8;

/** A first guess at an item's height; measuring corrects it once rendered. */
const estimateSize = () => 96;

/** The comment a page's address points at: `#comment-123` (the app's Copy link) or classic Forgejo's `#issuecomment-123`. */
function commentTarget(hash: string): number | undefined {
  const m = /^#?(?:issue)?comment-([1-9]\d{0,15})$/.exec(hash);
  return m ? Number(m[1]) : undefined;
}

/** The column holding the header, properties and description above the list: their height changes move the list (images loading, an edit). */
const conversationColumn = (el: HTMLElement) => el.closest('article') ?? el.parentElement;

const TargetContext = createContext<number | undefined>(undefined);

/** Allow the lazy group and virtualized rows up to 120 frames to reveal a permalink target. */
const SEEK_FRAMES = 120;

export const Timeline = observer(function Timeline({issueId, scroller}: {issueId: number; scroller: HTMLDivElement | null}) {
  const items = useItems(issueId);
  const pool = usePool();
  const [all, setAll] = useState(false);
  const hash = useRouterState({select: (s) => s.location.hash});
  const target = commentTarget(hash.startsWith('#') ? hash : `#${hash}`);
  const reviewOf = target === undefined ? 0 : pool.model('Comment').get(target)?.get('review_id') ?? 0;
  const targetIndex = target === undefined ? -1 :
    items.findIndex((it) => it.kind === 'comment' ? it.id === target : reviewOf > 0 && it.id === reviewOf);
  // A permalink target must render immediately to allow scrolling.
  const partial = !all && items.length > FIRST_PAINT && targetIndex < FIRST_PAINT;
  const virtual = items.length >= VIRTUALIZE_FROM && scroller !== null;
  const [place, margin] = useScrollMargin(virtual ? scroller : null, conversationColumn);
  // New key or size functions make the virtualizer recompute every position, so they change only with the items.
  const keys = virtual ? items.map(itemKey) : [];
  const keySig = keys.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature says when the keys changed
  const getItemKey = useCallback((i: number) => keys[i] ?? i, [keySig]);
  const list = useVirtualizer({
    count: items.length, enabled: virtual, getScrollElement: () => scroller, estimateSize, overscan: 4, scrollMargin: margin, getItemKey,
    ...pageListRect(),
  });
  const [highlight, setHighlight] = useState<number>();
  /** Scroll to each permalink once so later renders do not move the reader. */
  const scrolled = useRef('');
  useEffect(() => {
    if (!partial) return;
    afterPaint(() => {
      setAll(true);
    });
  }, [partial]);
  useEffect(() => {
    if (target === undefined || targetIndex < 0 || scrolled.current === hash) return undefined;
    let frame = 0;
    let raf = 0;
    let asked = false;
    const seek = () => {
      const card = document.getElementById(`comment-${String(target)}`);
      if (card) {
        scrolled.current = hash;
        card.scrollIntoView({block: 'start'});
        setHighlight(target);
        return;
      }
      // Virtual rows must be brought into view before seeking their DOM node.
      if (virtual && !asked) {
        asked = true;
        list.scrollToIndex(targetIndex, {align: 'start'});
      }
      if (++frame < SEEK_FRAMES) raf = requestAnimationFrame(seek);
    };
    seek();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [hash, target, targetIndex, virtual, list]);
  if (!items.length) return null;
  const render = (it: Item, key: string | number | bigint, row?: Row) => (it.kind === 'comment' ?
    <CommentItem key={String(key)} id={it.id} swapFrom={it.swapFrom} row={row}/> : <ReviewItem key={String(key)} id={it.id} row={row}/>);
  return (
    <TargetContext value={highlight}>
      <section aria-label="Activity">
        {!virtual ?
          <TimelineList>{(partial ? items.slice(0, FIRST_PAINT) : items).map((it) => render(it, itemKey(it)))}</TimelineList> :
          <div ref={place} className="relative" style={{height: list.getTotalSize()}}>
            <TimelineList>
              {list.getVirtualItems().map((row) => {
                const it = items[row.index];
                return it && render(it, row.key, {
                  ref: list.measureElement, 'data-index': row.index, className: 'absolute inset-x-0 top-0', style: {transform: `translateY(${String(row.start - margin)}px)`},
                });
              })}
            </TimelineList>
          </div>}
      </section>
    </TargetContext>
  );
});

function Who({id, fallback}: {id: number; fallback?: string}) {
  return <UserName id={id} fallback={firstOf(fallback ?? '', 'Someone')}/>;
}

/** The newest recorded edit of the description (`commentId` 0) or of a comment. */
function lastEditOf(pool: ReturnType<typeof usePool>, issueId: number, commentId: number) {
  const rows = commentId ? pool.model('ContentHistory').by('comment_id', commentId) : pool.model('ContentHistory').by('issue_id', issueId);
  return [...rows].map((e) => e.data)
    .filter((h) => h.comment_id === commentId && h.issue_id === issueId && !h.is_first_created)
    .sort((a, b) => b.edited_at.localeCompare(a.edited_at) || b.id - a.id)[0];
}

/** `at`: when, if the edit history is known (an issue's `updated_at` moves with any activity). */
function Edited({at, version}: {at: string | undefined; version: number}) {
  if (!(version > 0)) return null;
  return <span className="text-sm text-muted" title={at ? `Edited ${fullDate(at)}` : undefined}>edited</span>;
}

/** A comment on the timeline: the author's avatar in the conversation's gutter, the box over the timeline's line. */
function CommentEntry({poster, row, children}: {poster: number; row?: Row | undefined; children: ReactNode}) {
  return (
    <PrimerTimeline.Item {...row}>
      <PrimerTimeline.Avatar className="hidden @md/conversation:block"><UserAvatar id={poster} size="lg" linked/></PrimerTimeline.Avatar>
      <PrimerTimeline.Body className="mt-0 -ml-4 max-w-none">{children}</PrimerTimeline.Body>
    </PrimerTimeline.Item>
  );
}

/** `nested`: inside a review or thread, where no gutter avatar names the author. */
function Card({poster, original, at, verb, badge, actions, children, footer, id, linked, nested = false}: {
  poster: number; original: string; at: string; verb?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode;
  id?: string | undefined; linked?: boolean; nested?: boolean;
}) {
  return (
    <article id={id} aria-current={linked ? 'location' : undefined}
      className={clsx('relative flex min-w-0 flex-col rounded-md border bg-default text-base text-default', linked ? 'border-accent-emphasis' : 'border-default')}>
      <header className={clsx('flex min-h-10 flex-wrap items-center gap-x-1 rounded-t-md border-b py-1 pr-2 pl-4', linked ? 'border-accent-emphasis bg-accent-muted' : 'border-default bg-muted')}>
        <span className={clsx('mr-1', nested ? 'flex' : 'flex @md/conversation:hidden')}><UserAvatar id={poster} size="sm" linked/></span>
        <Who id={poster} fallback={original}/>
        {verb && <span className="text-muted">{verb}</span>}
        {id ? <RouterLink muted to="." search={true} hash={id}><TimeAgo at={at} variant="words"/></RouterLink> : <span className="text-muted"><TimeAgo at={at} variant="words"/></span>}
        {badge}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </header>
      <div className="p-4">{children}</div>
      {footer && <div className="px-4 pb-4">{footer}</div>}
    </article>
  );
}

/** The issue's description, the conversation's first card. */
export const DescriptionItem = observer(function DescriptionItem({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const pool = usePool();
  const {edit, start, stop, mayEdit} = useBodyEdit(issue);
  const actions = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!edit && refocus.current) actions.current?.focus();
    refocus.current = false;
  }, [edit]);
  const version = pool.model('IssueBody').get(issue.id)?.get('content_version') ?? 0;
  const lastEdit = version > 0 ? lastEditOf(pool, issue.id, 0) : undefined;
  return (
    <TimelineList clipSidebar="start">
      <CommentEntry poster={issue.get('poster_id')}>
        <Card id={issue.id > 0 ? `issue-${String(issue.id)}` : undefined} poster={issue.get('poster_id')} original={issue.get('original_author')} at={issue.get('created_at')} verb="opened"
          badge={<>
            <Edited at={lastEdit?.edited_at} version={version}/>
            {lastEdit && <span className="text-sm text-muted">by <Who id={lastEdit.poster_id}/></span>}
          </>}
          actions={<CardMenu triggerRef={actions} label="Description actions" issueId={issue.id}
            link={issue.id > 0 ? () => undefined : undefined} quote={() => issueBody(pool, editing(app).overlay, issue.id)?.text ?? ''} onEdit={mayEdit ? start : undefined}/>}
          footer={<Reactions issueId={issue.id} commentId={0}/>}>
          <BodySection issue={issue} edit={edit} mayEdit={mayEdit} onReopen={start} onEditDone={() => {
            refocus.current = true;
            stop();
          }}/>
        </Card>
      </CommentEntry>
    </TimelineList>
  );
});

const CommentItem = observer(function CommentItem({id, swapFrom, row}: {id: number; swapFrom?: number | undefined; row?: Row | undefined}) {
  const pool = usePool();
  const overlay = useOverlay();
  const c = pool.model('Comment').get(id) ?? overlay.createdEntity('Comment', id) as Entity<'Comment'> | undefined;
  if (!c) return null;
  const type = c.get('type');
  if (type === 'comment' || type === 'code' || type === 'dismiss_review') {
    if (overlay.field('Comment', id, DELETED)) return null;
    return <CommentEntry poster={c.get('poster_id')} row={row}><CommentCard c={c} type={type}/></CommentEntry>;
  }
  return <EventItem comment={c} swapFrom={swapFrom} row={row}/>;
});

export const CommentCard = observer(function CommentCard({c, type, badge, nested = false}: {c: Entity<'Comment'>; type: string; badge?: ReactNode; nested?: boolean}) {
  const [edit, setEdit] = useState(false);
  const actions = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const overlay = useOverlay();
  const pool = usePool();
  const lastEdit = c.get('content_version') > 0 ? lastEditOf(pool, c.get('issue_id'), c.id) : undefined;
  const deleted = commentBody(overlay, c).deleted;
  const linked = useContext(TargetContext) === c.id;
  useEffect(() => {
    if (!edit && refocus.current) actions.current?.focus();
    refocus.current = false;
  }, [edit]);
  if (deleted) return null;
  // The suggestion card replaces a body that is only a suggestion; otherwise the text shows as written.
  const suggestion = type === 'code' && !edit && suggestionOnly(c.get('body'), c.get('line')) && pullOf(pool, c.get('issue_id')) !== undefined;
  return (
    <Card id={`comment-${String(c.id)}`} linked={linked} nested={nested} poster={c.get('poster_id')} original={c.get('original_author')} at={c.get('created_at')}
      verb={type === 'dismiss_review' ? 'dismissed a review' : 'commented'}
      badge={<>
        {badge}
        <Edited at={lastEdit?.edited_at ?? c.get('updated_at')} version={c.get('content_version')}/>
        {lastEdit && <span className="text-sm text-muted">by <Who id={lastEdit.poster_id}/></span>}
        {type === 'code' && !nested && <Label>{c.get('path')}</Label>}
      </>}
      actions={c.id > 0 && <CommentActions c={c} triggerRef={actions} onEdit={() => {
        setEdit(true);
      }}/>}
      footer={<Reactions issueId={c.get('issue_id')} commentId={c.id}/>}>
      {type === 'code' && !edit && <SuggestionCard comment={c.data}/>}
      {!suggestion && <CommentBody c={c} edit={edit} onEditDone={() => {
        refocus.current = true;
        setEdit(false);
      }} onReopen={() => {
        setEdit(true);
      }}/>}
    </Card>
  );
});

type BadgeVariant = NonNullable<TimelineBadgeProps['variant']>;

const REVIEW_LOOK: Record<string, {icon: OcticonType; variant?: BadgeVariant; text: string}> = {
  APPROVED: {icon: CheckIcon, variant: 'success', text: 'approved these changes'},
  REQUEST_CHANGES: {icon: FileDiffIcon, variant: 'danger', text: 'requested changes'},
  COMMENT: {icon: EyeIcon, text: 'reviewed'},
};

const ReviewItem = observer(function ReviewItem({id, row}: {id: number; row?: Row | undefined}) {
  const pool = usePool();
  const r = pool.model('Review').get(id);
  if (!r) return null;
  const look = REVIEW_LOOK[r.get('state')] ?? {icon: EyeIcon, text: 'reviewed'};
  const reviewNote = [...pool.model('Comment').by('review_id', id)].find((c) => c.get('type') === 'review');
  const html = r.get('body_html');
  const codes = [...pool.model('Comment').by('review_id', id)].filter((c) => c.get('type') === 'code' && !replyRoot(pool, c));
  const body = reviewNote ? reviewNote.get('body').trim() !== '' && <CommentCard c={reviewNote} type="review" nested/> :
    html && <Card poster={r.get('reviewer_id')} original={r.get('original_author')} at={r.get('created_at')} verb="commented" nested><Markdown html={html}/></Card>;
  return (
    <PrimerTimeline.Item {...row}>
      <PrimerTimeline.Badge {...look.variant ? {variant: look.variant} : {}}>{createElement(look.icon)}</PrimerTimeline.Badge>
      <PrimerTimeline.Body>
        <div className="flex flex-wrap items-center gap-x-1">
          <span className="mr-1 flex"><UserAvatar id={r.get('reviewer_id')} size="sm" linked/></span>
          <Who id={r.get('reviewer_id')} fallback={r.get('original_author')}/> {look.text} <span className="text-muted"><TimeAgo at={r.get('created_at')} variant="words"/></span>
          {r.get('stale') && <Label>Outdated</Label>}
          {r.get('dismissed') && <Label>Dismissed</Label>}
        </div>
        {(body || codes.length > 0) && <div className="mt-3 flex flex-col gap-3">
          {body}
          {codes.map((c) => <CodeComment key={c.id} c={c}/>)}
        </div>}
      </PrimerTimeline.Body>
    </PrimerTimeline.Item>
  );
});

const SNIPPET_LINES = 4;

const CodeComment = observer(function CodeComment({c}: {c: Entity<'Comment'>}) {
  const app = useApp();
  const pool = usePool();
  const [replying, setReplying] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const closeReply = () => {
    setReplying(false);
    requestAnimationFrame(() => replyButton.current?.focus());
  };
  const [text, setText] = useState('');
  const root = conversationRoot(pool, c.data);
  const resolver = useResolver(root);
  const [shown, setShown] = useState(false);
  const issueEntity = pool.model('Issue').get(c.get('issue_id'));
  const issue = pool.model('Issue').get(c.get('issue_id'))?.data;
  const repo = issue ? pool.model('Repository').get(issue.repo_id)?.data : undefined;
  const files = issue && repo ? `/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(issue.number)}` : undefined;
  const path = c.get('path');
  const patch = c.get('diff_hunk');
  const hunk = useMemo(() => hunkFile(path, patch, SNIPPET_LINES), [path, patch]);
  const replies = conversationReplies(pool, c);
  const reply = () => {
    if (!issue || !text.trim() || hasPendingUploads(text)) return;
    submitReview(editing(app).intents, {
      issueId: issue.id, repoId: issue.repo_id, head: c.get('commit_id'), event: 'COMMENT', body: '',
      drafts: [{key: `reply:${uuid()}`, anchor: commentAnchor(c.data), text, at: Date.now()}],
    });
    setText('');
    closeReply();
  };
  if (resolver > 0 && !shown && !replying) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-default p-3">
        <span className="text-sm text-muted"><code>{c.get('path')}</code> line {Math.abs(c.get('line'))}</span>
        <ResolvedFold resolver={resolver} onShow={() => {
          setShown(true);
        }}/>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-default p-3">
      <span className="text-sm text-muted">
        <Who id={c.get('poster_id')} fallback={c.get('original_author')}/> on{' '}
        {files ? <RouterLink to={files} search={{tab: 'files'}} hash={`review-thread-${String(c.id)}`} muted className="min-w-0 truncate"><code>{c.get('path')}</code>line {Math.abs(c.get('line'))}</RouterLink> :
          <><code>{c.get('path')}</code> line {Math.abs(c.get('line'))}</>}
        {c.get('invalidated') && <> · <Label>Outdated</Label></>}
      </span>
      {hunk.lines.length > 0 && <DiffSnippet file={hunk}/>}
      <CommentCard c={c} type="code" nested/>
      {replies.map((r) => <CommentCard key={r.id} c={r} type="code" nested/>)}
      {issue && !c.get('invalidated') && (replying ?
        <div className="flex flex-col gap-2">
          <MarkdownField repoId={issue.repo_id} attachmentIssueId={issue.id} label="Reply" value={text} rows={2} autoFocus onChange={setText} onSubmit={reply} onCancel={() => {
            closeReply();
          }}/>
          <div className="flex justify-end gap-2">
            <Button variant="invisible" size="small" type="button" onClick={() => {
              closeReply();
            }}>Cancel</Button>
            <Button variant="primary" size="small" type="button" disabled={!text.trim() || hasPendingUploads(text)} onClick={reply}>Reply</Button>
          </div>
        </div> :
        <div className="flex items-center gap-2">
          <Button variant="invisible" size="small" leadingVisual={ReplyIcon} type="button" ref={replyButton} onClick={() => {
            setReplying(true);
          }}>Reply</Button>
          {root && issueEntity && <ResolveButton root={root} issue={issueEntity}/>}
        </div>)}
    </div>
  );
});

interface EventLook {
  icon: OcticonType;
  text: ReactNode;
  /** State changes get GitHub's coloured badge; other events are condensed. */
  variant?: BadgeVariant | 'neutral';
}

const EventItem = observer(function EventItem({comment: c, swapFrom, row}: {comment: Entity<'Comment'>; swapFrom?: number | undefined; row?: Row | undefined}) {
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
  const chip = <IssueLabelToken text={kind ? scopedValue(l.get('name')) : l.get('name')} fillColor={labelColor(l.get('color'))}/>;
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
    <>added {ids.length === 1 ? '1 commit' : `${String(ids.length)} commits`}{' '}
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

