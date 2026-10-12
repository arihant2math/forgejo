// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Label, Timeline as PrimerTimeline} from '@primer/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {createContext, type CSSProperties, type ReactNode, useContext, useEffect, useRef, useState} from 'react';
import {RouterLink} from '../../app/routerLinks.tsx';
import {fullDate} from '../../app/time.ts';
import {pullOf} from '../../code/pull.ts';
import {BoxHeader} from '../../components/BorderBox.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {Entity} from '../../data/entity.ts';
import {commentBody} from '../../intents/view.ts';
import {firstOf, useOverlay, usePool, UserAvatar, UserName} from '../issues/cells.tsx';
import {SuggestionCard} from '../pull/Suggestion.tsx';
import {suggestionOnly} from '../pull/suggestions.ts';
import {CommentActions, CommentBody} from './CommentEditing.tsx';
import {Reactions} from './Reactions.tsx';

/** A virtual row's measuring ref and position (computed, so a style), set on the timeline item itself so the list holds only its items. */
export interface Row {
  ref: (el: Element | null) => void;
  'data-index': number;
  className: string;
  style: CSSProperties;
}

export const TargetContext = createContext<number | undefined>(undefined);

export function Who({id, fallback}: {id: number; fallback?: string}) {
  return <UserName id={id} fallback={firstOf(fallback ?? '', 'Someone')}/>;
}

/** The newest recorded edit of the description (`commentId` 0) or of a comment. */
export function lastEditOf(pool: ReturnType<typeof usePool>, issueId: number, commentId: number) {
  const rows = commentId ? pool.model('ContentHistory').by('comment_id', commentId) : pool.model('ContentHistory').by('issue_id', issueId);
  return [...rows].map((e) => e.data)
    .filter((h) => h.comment_id === commentId && h.issue_id === issueId && !h.is_first_created)
    .sort((a, b) => b.edited_at.localeCompare(a.edited_at) || b.id - a.id)[0];
}

/** `at`: when, if the edit history is known (an issue's `updated_at` moves with any activity). */
export function Edited({at, version}: {at: string | undefined; version: number}) {
  if (!(version > 0)) return null;
  return <span className="text-sm text-muted" title={at ? `Edited ${fullDate(at)}` : undefined}>edited</span>;
}

/** A comment on the timeline: the author's avatar in the conversation's gutter, the box over the timeline's line. */
export function CommentEntry({poster, row, children}: {poster: number; row?: Row | undefined; children: ReactNode}) {
  return (
    <PrimerTimeline.Item {...row}>
      <PrimerTimeline.Avatar className="hidden @md/conversation:block"><UserAvatar id={poster} size="lg" linked/></PrimerTimeline.Avatar>
      <PrimerTimeline.Body className="mt-0 -ml-4 max-w-none">{children}</PrimerTimeline.Body>
    </PrimerTimeline.Item>
  );
}

/** `nested`: inside a review or thread, where no gutter avatar names the author. */
export function Card({poster, original, at, verb, badge, actions, children, footer, id, linked, nested = false}: {
  poster: number; original: string; at: string; verb?: string | undefined; badge?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode;
  id?: string | undefined; linked?: boolean; nested?: boolean;
}) {
  return (
    <article id={id} aria-current={linked ? 'location' : undefined}
      className={clsx('relative flex min-w-0 flex-col rounded-md border bg-default text-base text-default', linked ? 'border-accent-emphasis' : 'border-default')}>
      <BoxHeader accent={linked} actions={actions}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1">
          <span className={clsx('mr-1', nested ? 'flex' : 'flex @md/conversation:hidden')}><UserAvatar id={poster} size="sm" linked/></span>
          <Who id={poster} fallback={original}/>
          {verb && <span className="text-muted">{verb}</span>}
          {id ? <RouterLink muted to="." search={true} hash={id}><TimeAgo at={at} variant="words"/></RouterLink> : <span className="text-muted"><TimeAgo at={at} variant="words"/></span>}
          {badge}
        </span>
      </BoxHeader>
      <div className="p-4">{children}</div>
      {footer && <div className="px-4 pb-4">{footer}</div>}
    </article>
  );
}

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
