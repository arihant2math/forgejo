// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Virtualize long timelines against the page scroller; each item observes its own entity.

import {SuggestionCard} from '../pull/Suggestion.tsx';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {createElement, createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {VirtuosoHandle} from 'react-virtuoso';
import type {Entity} from '../../data/entity.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {clsx} from 'clsx';
import {useParams, useRouterState} from '@tanstack/react-router';
import {commentAnchor} from '../../code/anchor.ts';
import {submitReview} from '../../code/review.ts';
import {uuid} from '../../intents/intents.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {hasPendingUploads} from '../editor/attachments.ts';
import {shortSha} from '../../code/refs.ts';
import {hunkFile} from '../../code/hunk.ts';
import {DiffSnippet} from '../../code/DiffSnippet.tsx';
import {CodeLink} from '../code/nav.tsx';
import {useApp} from '../../app/store.ts';
import {DELETED} from '../../intents/overlay.ts';
import {editing} from '../../intents/session.ts';
import {commentBody, issueComments, viewMembers} from '../../intents/view.ts';
import {firstOf, labelColor, useOverlay, usePool, UserAvatar, UserName} from '../issues/cells.tsx';
import {labelKind, scopedValue, statusStage} from '../issues/labels.ts';
import {agoWords, fullDate, shortDate} from '../issues/format.ts';
import {CommentActions, CommentBody} from './Editing.tsx';
import {Markdown} from './Markdown.tsx';
import {afterPaint} from '../../app/paint.ts';
import {textOfMarkup} from '../../app/trusted.ts';
import {Reactions} from './Reactions.tsx';
import {blocking, IssueLink} from './Sidebar.tsx';
import {conversationReplies, conversationRoot, replyOnlyReview, replyRoot, ResolveButton, ResolvedFold, useResolver} from '../pull/resolve.tsx';
import {ArrowSwitchIcon, BookmarkIcon, CalendarIcon, CheckCircleIcon, IssueOpenedIcon, ClockIcon, EyeIcon, GitBranchIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon, LinkIcon, LockIcon, UnlockIcon, CommentIcon, MilestoneIcon, PencilIcon, PinIcon, PinSlashIcon, ReplyIcon, ProjectIcon, TagIcon, PersonIcon, PersonAddIcon, XCircleIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, IssueLabelToken, Label} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

const VIRTUALIZE_FROM = 50;

/** `swapFrom`: a label event that replaced this label (the same field: a status changed from one to another). */
type Item = {kind: 'comment'; id: number; at: string; swapFrom?: number} | {kind: 'review'; id: number; at: string};

function useItems(issueId: number): Item[] {
  const pool = usePool();
  const app = useApp();
  const {overlay, intents} = editing(app);
  const comments = issueComments(pool, overlay, issueId, intents.remapped);
  const reviews = pool.model('Review').by('issue_id', issueId);
  return untracked(() => {
    const out: Item[] = [];
    for (const c of comments) {
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

const Virtuoso = lazy(() => import('react-virtuoso').then((m) => ({default: m.Virtuoso as typeof m.Virtuoso<Item>})));

/** Limit first-paint work: rendering many comment bodies can delay a slow device by a frame. */
const FIRST_PAINT = 8;

/** The comment a page's address points at: `#comment-123` (the app's Copy link) or classic Forgejo's `#issuecomment-123`. */
export function commentTarget(hash: string): number | undefined {
  const m = /^#?(?:issue)?comment-([1-9]\d{0,15})$/.exec(hash);
  return m ? Number(m[1]) : undefined;
}

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
  const virtuoso = useRef<VirtuosoHandle>(null);
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
      if (virtual && !asked && virtuoso.current) {
        asked = true;
        virtuoso.current.scrollToIndex({index: targetIndex, align: 'start'});
      }
      if (++frame < SEEK_FRAMES) raf = requestAnimationFrame(seek);
    };
    seek();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [hash, target, targetIndex, virtual]);
  if (!items.length) return null;
  const render = (it: Item) => (it.kind === 'comment' ? <CommentItem id={it.id} swapFrom={it.swapFrom}/> : <ReviewItem id={it.id}/>);
  return (
    <TargetContext value={highlight}>
      <section aria-label="Activity" className="flex flex-col">
        {!virtual ?
          (partial ? items.slice(0, FIRST_PAINT) : items).map((it) => <div key={`${it.kind}${String(it.id)}`}>{render(it)}</div>) :
          <Suspense fallback={items.slice(0, 20).map((it) => <div key={`${it.kind}${String(it.id)}`}>{render(it)}</div>)}>
            <Virtuoso ref={virtuoso} customScrollParent={scroller} data={items} increaseViewportBy={600}
              computeItemKey={(_, it) => `${it.kind}${String(it.id)}`} itemContent={(_, it) => render(it)}/>
          </Suspense>}
      </section>
    </TargetContext>
  );
});

function Who({id, fallback}: {id: number; fallback?: string}) {
  return <UserName id={id} fallback={firstOf(fallback ?? '', 'Someone')}/>;
}

function When({at}: {at: string}) {
  return <time dateTime={at} title={fullDate(at)} className="text-sm text-muted">{agoWords(at)}</time>;
}

export function Edited({updated, version}: {updated: string; version: number}) {
  if (!(version > 0)) return null;
  return <span className="text-sm text-muted" title={`Edited ${fullDate(updated)}`}>edited</span>;
}

function Card({poster, original, at, badge, children, footer, id, linked}: {
  poster: number; original: string; at: string; badge?: ReactNode; children: ReactNode; footer?: ReactNode; id?: string; linked?: boolean;
}) {
  return (
    <article id={id} aria-current={linked ? 'location' : undefined} className={clsx('flex gap-4 py-3', linked && '-mx-2 rounded-md bg-accent-muted px-2')}>
      <UserAvatar id={poster} size="lg" linked/>
      <div className="flex min-w-0 flex-1 flex-col rounded-md border border-default">
        <header className="flex flex-wrap items-center gap-x-2 rounded-t-md border-b border-default bg-muted px-4 py-2 text-base">
          <Who id={poster} fallback={original}/>
          <When at={at}/>
          {badge}
        </header>
        <div className="p-4">{children}</div>
        {footer && <div className="px-4 pb-4">{footer}</div>}
      </div>
    </article>
  );
}

const CommentItem = observer(function CommentItem({id, swapFrom}: {id: number; swapFrom?: number | undefined}) {
  const pool = usePool();
  const overlay = useOverlay();
  const c = pool.model('Comment').get(id) ?? overlay.createdEntity('Comment', id) as Entity<'Comment'> | undefined;
  if (!c) return null;
  const type = c.get('type');
  if (type === 'comment' || type === 'code' || type === 'dismiss_review') {
    if (overlay.field('Comment', id, DELETED)) return null;
    return <CommentCard c={c} type={type}/>;
  }
  return <EventLine comment={c} swapFrom={swapFrom}/>;
});

export const CommentCard = observer(function CommentCard({c, type, badge}: {c: Entity<'Comment'>; type: string; badge?: ReactNode}) {
  const [edit, setEdit] = useState(false);
  const actions = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const overlay = useOverlay();
  const pool = usePool();
  const lastEdit = [...pool.model('ContentHistory').by('comment_id', c.id)].map((e) => e.data)
    .filter((h) => h.comment_id === c.id && !h.is_first_created)
    .sort((a, b) => b.edited_at.localeCompare(a.edited_at) || b.id - a.id)[0];
  const deleted = commentBody(overlay, c).deleted;
  const linked = useContext(TargetContext) === c.id;
  useEffect(() => {
    if (!edit && refocus.current) actions.current?.focus();
    refocus.current = false;
  }, [edit]);
  if (deleted) return null;
  return (
    <Card id={`comment-${String(c.id)}`} linked={linked} poster={c.get('poster_id')} original={c.get('original_author')} at={c.get('created_at')}
      badge={<>
        {badge}
        <Edited updated={c.get('updated_at')} version={c.get('content_version')}/>
        {c.get('content_version') > 0 && lastEdit && <span className="text-sm text-muted">by <Who id={lastEdit.poster_id}/></span>}
        {type === 'dismiss_review' ? <Label variant="attention">dismissed a review</Label> : type === 'code' ? <Label>{c.get('path')}</Label> : undefined}
        {c.id > 0 && <CommentActions c={c} triggerRef={actions} onEdit={() => {
          setEdit(true);
        }}/>}
      </>}
      footer={<Reactions issueId={c.get('issue_id')} commentId={c.id}/>}>
      {type === 'code' && !edit && <SuggestionCard comment={c.data}/>}
      {(edit || type !== 'code' || !/^```suggestion(?: -\d+\+\d+)?\r?\n[\s\S]*?\r?\n```$/.test(c.get('body').trim())) && <CommentBody c={c} edit={edit} onEditDone={() => {
        refocus.current = true;
        setEdit(false);
      }} onReopen={() => {
        setEdit(true);
      }}/> }
    </Card>
  );
});

const REVIEW_LOOK: Record<string, {tone: 'success' | 'danger' | 'secondary'; text: string}> = {
  APPROVED: {tone: 'success', text: 'approved'},
  REQUEST_CHANGES: {tone: 'danger', text: 'requested changes'},
  COMMENT: {tone: 'secondary', text: 'reviewed'},
};

const ReviewItem = observer(function ReviewItem({id}: {id: number}) {
  const pool = usePool();
  const r = pool.model('Review').get(id);
  if (!r) return null;
  const look = REVIEW_LOOK[r.get('state')] ?? {tone: 'secondary' as const, text: 'reviewed'};
  const summary = [...pool.model('Comment').by('review_id', id)].find((c) => c.get('type') === 'review');
  const html = r.get('body_html');
  const codes = [...pool.model('Comment').by('review_id', id)].filter((c) => c.get('type') === 'code' && !replyRoot(pool, c));
  return (
    <Card poster={r.get('reviewer_id')} original={r.get('original_author')} at={r.get('created_at')}
      badge={<Label variant={look.tone}>{look.text}{r.get('stale') ? ' · outdated' : ''}{r.get('dismissed') ? ' · dismissed' : ''}</Label>}>
      {summary ? summary.get('body').trim() !== '' && <CommentCard c={summary} type="review"/> : html && <Markdown html={html}/>}
      {codes.map((c) => <CodeComment key={c.id} c={c}/>)}
    </Card>
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
      <CommentCard c={c} type="code"/>
      {replies.map((r) => <CommentCard key={r.id} c={r} type="code"/>)}
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

const EventLine = observer(function EventLine({comment: c, swapFrom}: {comment: Entity<'Comment'>; swapFrom?: number | undefined}) {
  const d = c.data as Comment;
  const ev = swapFrom === undefined ? describeEvent(d) : {icon: TagIcon, text: <LabelSwap from={swapFrom} to={d.label_id}/>};
  return (
    <div className="flex min-h-control items-center gap-4 py-2 text-base text-muted">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-neutral-muted">{createElement(ev.icon, {size: 16})}</span>
      <span className="min-w-0">
        <Who id={d.poster_id} fallback={d.original_author}/> {ev.text}<span className="ml-2 inline-block"><When at={d.created_at}/></span>
      </span>
    </div>
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

/** Status changes keep the triggering SHA; older events can use the adjacent commit reference. */
export const StatusEvent = observer(function StatusEvent({d}: {d: Comment}) {
  const pool = usePool();
  const comments = [...pool.model('Comment').by('issue_id', d.issue_id)].map((c) => c.data);
  const previous = comments.filter((c) => c.id < d.id).sort((a, b) => b.id - a.id)[0];
  const reference = comments.find((c) => c.type === 'commit_ref' && c.commit_id === d.commit_id) ??
    (previous?.type === 'commit_ref' && previous.poster_id === d.poster_id && previous.created_at === d.created_at ? previous : undefined);
  const sha = d.commit_id !== '' ? d.commit_id : reference?.commit_id;
  const repoId = d.ref_repo_id > 0 ? d.ref_repo_id : pool.model('Issue').get(d.issue_id)?.get('repo_id') ?? 0;
  const repo = pool.model('Repository').get(repoId)?.data;
  const pull = [...pool.model('PullRequest').all()].find((p) => p.get('base_repo_id') === repoId &&
    ((Boolean(sha) && p.get('merge_commit_sha') === sha) || (d.ref_is_pull && p.get('issue_id') === d.ref_issue_id)));
  const action = d.type === 'close' ? 'closed this' : 'reopened this';
  const message = reference?.body_html ? textOfMarkup(reference.body_html).trim().split('\n')[0] ?? '' : '';
  const reason = d.type === 'close' && !sha && !d.ref_is_pull ? closeReason(pool, comments, d) : undefined;
  if (reason?.duplicateOf !== undefined) {
    const original = [...pool.model('Issue').by('number', reason.duplicateOf)].find((i) => i.get('repo_id') === repoId);
    return <>closed this as a duplicate of {original ? <IssueRef id={original.id} from={d.issue_id}/> : `#${String(reason.duplicateOf)}`}</>;
  }
  if (reason?.notPlanned) return <>closed this as not planned</>;
  return <>{action}{sha && repo && <> in <span><CodeLink owner={repo.owner_name} repo={repo.name} to={`commit/${sha}`}>
    <span className="font-mono">{shortSha(sha)}</span>{message ? ` ${message}` : ''}
  </CodeLink></span></>}{pull && <> in <IssueRef id={pull.get('issue_id')} from={d.issue_id}/></>}
  {!pull && d.ref_is_pull && d.ref_issue_id > 0 && <> in <IssueRef id={d.ref_issue_id} from={d.issue_id}/></>}</>;
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
  const message = d.body_html ? textOfMarkup(d.body_html).trim().split('\n')[0] ?? '' : '';
  if (!sha || !r) return <>referenced this in a commit</>;
  return (
    <>referenced this in <span><CodeLink owner={r.owner_name} repo={r.name} to={`commit/${sha}`}>
      <span className="font-mono">{shortSha(sha)}</span>{message ? ` ${message}` : ''}
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
    <span key={sha}><CodeLink owner={r.owner_name} repo={r.name} to={`commit/${sha}`}><span className="font-mono">{shortSha(sha)}</span></CodeLink></span> :
    <span key={sha} className="font-mono">{shortSha(sha)}</span>);
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

function describeEvent(d: Comment): {icon: OcticonType; text: ReactNode} {
  switch (d.type) {
    case 'close':
      return {icon: CheckCircleIcon, text: <StatusEvent d={d}/>};
    case 'reopen':
      return {icon: IssueOpenedIcon, text: <StatusEvent d={d}/>};
    case 'merge_pull':
      return {icon: GitMergeIcon, text: 'merged this'};
    case 'label':
      return {icon: TagIcon, text: <LabelEvent id={d.label_id} added={d.body === '1'}/>};
    case 'milestone':
      if (!d.milestone_id) return {icon: MilestoneIcon, text: <>removed this from <MilestoneRef id={d.old_milestone_id}/></>};
      return {icon: MilestoneIcon, text: <>{d.old_milestone_id ? 'moved this to' : 'added this to'} <MilestoneRef id={d.milestone_id}/></>};
    case 'assignees':
      if (d.assignee_id === d.poster_id) return {icon: d.removed_assignee ? PersonIcon : PersonIcon, text: d.removed_assignee ? 'removed their assignment' : 'self-assigned this'};
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

