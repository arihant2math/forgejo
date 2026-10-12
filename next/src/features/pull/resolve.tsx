// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo stores resolution on the first code comment at a file/line; update it through an offline intent.
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {canWrite} from '../../app/access.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {editing} from '../../intents/session.ts';
import {commentResolver} from '../../intents/view.ts';
import {useOverlay, UserName} from '../issues/cells.tsx';
import {CheckCircleIcon, IssueOpenedIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';

/** Forgejo reads resolution from the root comment; drafts have no root. */
export function conversationRoot(pool: Pool, c: Comment): Entity<'Comment'> | undefined {
  let root: Entity<'Comment'> | undefined;
  for (const o of pool.model('Comment').by('issue_id', c.issue_id)) {
    if (o.id <= 0 || o.get('type') !== c.type || o.get('path') !== c.path || o.get('line') !== c.line) continue;
    if (!root || o.get('created_at') < root.get('created_at') || (o.get('created_at') === root.get('created_at') && o.id < root.id)) root = o;
  }
  return root;
}

function inPendingReview(pool: Pool, c: Entity<'Comment'>): boolean {
  const review = c.get('review_id');
  return review > 0 && pool.model('Review').get(review)?.get('state') === 'PENDING';
}

/** Replies are separate reviews in Forgejo; return their displayed thread root, or undefined for a new thread. */
export function replyRoot(pool: Pool, c: Entity<'Comment'>): Entity<'Comment'> | undefined {
  if (c.get('type') !== 'code') return undefined;
  const root = conversationRoot(pool, c.data);
  return root && root.id !== c.id && !inPendingReview(pool, root) ? root : undefined;
}

/** Posted replies only, ordered oldest first. */
export function conversationReplies(pool: Pool, root: Entity<'Comment'>): Entity<'Comment'>[] {
  const out: Entity<'Comment'>[] = [];
  for (const o of pool.model('Comment').by('issue_id', root.get('issue_id'))) {
    if (o.id === root.id || o.id <= 0 || o.get('type') !== root.get('type') || o.get('path') !== root.get('path') || o.get('line') !== root.get('line')) continue;
    if (inPendingReview(pool, o) || replyRoot(pool, o)?.id !== root.id) continue;
    out.push(o);
  }
  return out.sort((a, b) => a.get('created_at').localeCompare(b.get('created_at')) || a.id - b.id);
}

/** Reply-only reviews render in existing threads, not as standalone timeline entries. */
export function replyOnlyReview(pool: Pool, reviewId: number): boolean {
  const r = pool.model('Review').get(reviewId);
  if (r?.get('state') !== 'COMMENT' || r.get('body').trim()) return false;
  let codes = 0;
  for (const c of pool.model('Comment').by('review_id', reviewId)) {
    if (c.get('type') === 'review') {
      if (c.get('body').trim()) return false;
      continue;
    }
    if (c.get('type') !== 'code' || !replyRoot(pool, c)) return false;
    codes++;
  }
  return codes > 0;
}

/** Resolver id, including optimistic edits; 0 means open. */
export function useResolver(root: Entity<'Comment'> | undefined): number {
  const overlay = useOverlay();
  return root ? commentResolver(overlay, root) : 0;
}

export const ResolveButton = observer(function ResolveButton({root, issue}: {root: Entity<'Comment'>; issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const resolved = useResolver(root) > 0;
  if (root.id <= 0 || (issue.get('poster_id') !== session.userId && !canWrite(session, issue.get('repo_id')))) return null;
  return (
    <Button variant="invisible" size="small" leadingVisual={resolved ? IssueOpenedIcon : CheckCircleIcon} type="button" onClick={(e) => {
      const button = e.currentTarget;
      const thread = button.parentElement?.parentElement;
      requestAnimationFrame(() => {
        if (button.isConnected) button.focus();
        else thread?.querySelector<HTMLButtonElement>('button')?.focus();
      });
      runInAction(() => {
        editing(app).intents.submit({kind: 'comment.resolve', issueId: issue.id, repoId: issue.get('repo_id'), commentId: root.id, resolved: !resolved});
      });
    }}>{resolved ? 'Unresolve' : 'Resolve'}</Button>
  );
});

export function ResolvedFold({resolver, onShow}: {resolver: number; onShow: () => void}) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <CheckCircleIcon size={12} className="shrink-0 text-success"/>
      <span>Resolved by <UserName id={resolver}/></span>
      <Button variant="invisible" size="small" type="button" onClick={onShow}>Show</Button>
    </div>
  );
}
