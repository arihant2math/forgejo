// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Resolving a review conversation (the classic Files tab's Resolve): an
// offline-capable intent (comment.resolve, a gap endpoint), shown at once. A
// conversation is the code comments on one line of one file (Forgejo's
// FetchCodeConversations); its first comment carries the resolution.

import {CircleCheck, CircleDot} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {canWrite} from '../../app/access.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {Comment} from '../../protocol/types.gen.ts';
import {editing} from '../../intents/session.ts';
import {commentResolver} from '../../intents/view.ts';
import {Button, Icon} from '../../ui/index.ts';
import {useOverlay, UserName} from '../issues/cells.tsx';

/** The first comment of the conversation `c` is in (the one Forgejo reads the resolution from); undefined for a draft. */
export function conversationRoot(pool: Pool, c: Comment): Entity<'Comment'> | undefined {
  let root: Entity<'Comment'> | undefined;
  for (const o of pool.model('Comment').by('issue_id', c.issue_id)) {
    if (o.id <= 0 || o.get('type') !== c.type || o.get('path') !== c.path || o.get('line') !== c.line) continue;
    if (!root || o.get('created_at') < root.get('created_at') || (o.get('created_at') === root.get('created_at') && o.id < root.id)) root = o;
  }
  return root;
}

/** Who resolved the conversation (0: open), as the user sees it. */
export function useResolver(root: Entity<'Comment'> | undefined): number {
  const overlay = useOverlay();
  return root ? commentResolver(overlay, root) : 0;
}

/** Resolve / Unresolve, for those Forgejo lets (the pull request's poster and its writers). */
export const ResolveButton = observer(function ResolveButton({root, issue}: {root: Entity<'Comment'>; issue: Entity<'Issue'>}) {
  const app = useApp();
  const session = useSession();
  const resolved = useResolver(root) > 0;
  if (root.id <= 0 || (issue.get('poster_id') !== session.userId && !canWrite(session, issue.get('repo_id')))) return null;
  return (
    <Button size="sm" variant="ghost" icon={resolved ? CircleDot : CircleCheck} onClick={() => {
      runInAction(() => {
        editing(app).intents.submit({kind: 'comment.resolve', issueId: issue.id, repoId: issue.get('repo_id'), commentId: root.id, resolved: !resolved});
      });
    }}>{resolved ? 'Unresolve' : 'Resolve'}</Button>
  );
});

/** A resolved conversation folded to one line (Linear, GitHub): who resolved it, and Show. */
export function ResolvedFold({resolver, onShow}: {resolver: number; onShow: () => void}) {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-muted">
      <Icon icon={CircleCheck} size="sm" className="text-success"/>
      <span>Resolved by <UserName id={resolver}/></span>
      <Button size="sm" variant="ghost" onClick={onShow}>Show</Button>
    </div>
  );
}
