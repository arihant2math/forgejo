// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reactions on an issue or a comment (read-only in F4; adding them is F6):
// one chip per reaction with its count, highlighted when the viewer is among
// those who reacted, naming them on hover.

import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {Badge} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';

/** Forgejo's default [ui] REACTIONS; other (custom) ones show by name. */
const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', 'laugh': '😄', 'hooray': '🎉', 'confused': '😕', 'heart': '❤️', 'rocket': '🚀', 'eyes': '👀',
};

export const Reactions = observer(function Reactions({issueId, commentId}: {issueId: number; commentId: number}) {
  const pool = usePool();
  const me = useSession().userId;
  const rows = pool.model('Reaction').by(commentId ? 'comment_id' : 'issue_id', commentId || issueId);
  const groups = untracked(() => {
    const out = new Map<string, {users: number[]; names: string[]}>();
    for (const r of rows) {
      if (r.data.comment_id !== commentId || r.data.issue_id !== issueId) continue;
      let g = out.get(r.data.content);
      if (!g) out.set(r.data.content, g = {users: [], names: []});
      g.users.push(r.data.user_id);
      g.names.push(pool.model('User').get(r.data.user_id)?.data.login ?? r.data.original_author);
    }
    return [...out].sort((a, b) => b[1].users.length - a[1].users.length || a[0].localeCompare(b[0]));
  });
  if (!groups.length) return null;
  return (
    <ul aria-label="Reactions" className="flex flex-wrap gap-1">
      {groups.map(([content, g]) => (
        <li key={content} title={`${g.names.filter(Boolean).join(', ')} reacted with ${content}`}>
          <Badge tone={g.users.includes(me) ? 'accent' : 'neutral'}>
            <span aria-hidden>{EMOJI[content] ?? `:${content}:`}</span>
            <span className="sr-only">{content}</span>
            {g.users.length}
          </Badge>
        </li>
      ))}
    </ul>
  );
});
