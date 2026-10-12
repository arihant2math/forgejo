// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon as OcticonType} from '@primer/octicons-react';
import {
CheckIcon,
EyeIcon,FileDiffIcon
} from '@primer/octicons-react';
import {Label, Timeline as PrimerTimeline} from '@primer/react';
import {FeatureFlags} from '@primer/react/experimental';
import {useRouterState} from '@tanstack/react-router';
import {useVirtualizer} from '@tanstack/react-virtual';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {createElement, type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import {afterPaint} from '../../app/paint.ts';
import {pageListRect} from '../../app/shell/Frame.tsx';
import {useApp} from '../../app/store.ts';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {Entity} from '../../data/entity.ts';
import {DELETED} from '../../intents/overlay.ts';
import {editing} from '../../intents/editing.ts';
import {issueBody, issueComments} from '../../intents/view.ts';
import {useScrollMargin} from '../code/Lines.tsx';
import {useOverlay} from '../../intents/editing.ts';
import {usePool} from '../../app/store.ts';
import {UserAvatar} from '../issues/cells.tsx';
import {labelKind} from '../issues/labels.ts';
import {replyOnlyReview, replyRoot} from '../pull/resolve.tsx';
import {CodeComment} from './CodeComment.tsx';
import {CardMenu} from './CommentEditing.tsx';
import {BodySection, useBodyEdit} from './Editing.tsx';
import {Markdown} from './Markdown.tsx';
import {Reactions} from './Reactions.tsx';
import {type BadgeVariant, EventItem} from './TimelineEvents.tsx';
import {Card, CommentCard, CommentEntry, Edited, lastEditOf, type Row, TargetContext, Who} from './TimelineParts.tsx';

const VIRTUALIZE_FROM = 50;

/** `swapFrom`: a label event that replaced this label (the same field: a status changed from one to another). */
type Item = {kind: 'comment'; id: number; at: string; swapFrom?: number} | {kind: 'review'; id: number; at: string};

const itemKey = (it: Item) => `${it.kind}${String(it.id)}`;

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
      <section aria-label="Activity" tabIndex={-1} className="outline-none">
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
        <Card id={issue.id > 0 ? `issue-${String(issue.id)}` : undefined} permalink={issue.id > 0 ? `issue-${String(issue.id)}` : undefined} poster={issue.get('poster_id')} original={issue.get('original_author')} at={issue.get('created_at')} verb="opened"
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
