// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reactions on an issue or a comment: one chip per reaction with its count,
// pressed when the viewer reacted, naming who did on hover. Clicking a chip
// (or picking an emoji from the menu) adds or removes the viewer's reaction:
// an offline-capable intent (`reaction`), counted at once.

import {SmilePlus} from 'lucide-react';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useApp, useSession} from '../../app/store.ts';
import {isTemp} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import {viewMembers} from '../../intents/view.ts';
import {ChipButton, IconButton, Menu, MenuContent, MenuItem, MenuTrigger} from '../../ui/index.ts';
import {useOverlay, usePool} from '../issues/cells.tsx';

/** Forgejo's default [ui] REACTIONS; other (custom) ones show by name. */
const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', 'laugh': '😄', 'hooray': '🎉', 'confused': '😕', 'heart': '❤️', 'rocket': '🚀', 'eyes': '👀',
};
/** Their names in words (the menu's accessible names). */
const NAMES: Record<string, string> = {
  '+1': 'Thumbs up', '-1': 'Thumbs down', 'laugh': 'Laugh', 'hooray': 'Hooray', 'confused': 'Confused', 'heart': 'Heart', 'rocket': 'Rocket', 'eyes': 'Eyes',
};
const DEFAULTS = Object.keys(EMOJI);

export const Reactions = observer(function Reactions({issueId, commentId}: {issueId: number; commentId: number}) {
  const app = useApp();
  const pool = usePool();
  const overlay = useOverlay();
  const me = useSession().userId;
  const rows = pool.model('Reaction').by(commentId ? 'comment_id' : 'issue_id', commentId || issueId);
  // The viewer's reactions as they see them (pending adds and removes included).
  const mine = viewMembers(pool, overlay, commentId ? 'CommentReaction' : 'IssueReaction', commentId || issueId, me);
  const groups = untracked(() => {
    const out = new Map<string, {others: string[]}>();
    for (const r of rows) {
      if (r.data.comment_id !== commentId || r.data.issue_id !== issueId) continue;
      let g = out.get(r.data.content);
      if (!g) out.set(r.data.content, g = {others: []});
      if (r.data.user_id !== me) g.others.push(pool.model('User').get(r.data.user_id)?.data.login ?? r.data.original_author);
    }
    for (const m of mine) if (typeof m === 'string' && !out.has(m)) out.set(m, {others: []});
    return [...out]
      .map(([content, g]) => ({content, others: g.others, mine: mine.has(content), count: g.others.length + Number(mine.has(content))}))
      .filter((g) => g.count > 0)
      .sort((a, b) => b.count - a.count || a.content.localeCompare(b.content));
  });
  // A comment posted offline gets reactions once Forgejo has it.
  const canReact = !isTemp(issueId) && !isTemp(commentId);
  const toggle = (content: string, add: boolean) => {
    const repoId = untracked(() => pool.model('Issue').get(issueId)?.data.repo_id ?? 0);
    runInAction(() => {
      editing(app).intents.submit({kind: 'reaction', issueId, repoId, commentId, content, add});
    });
  };
  if (!groups.length && !canReact) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {groups.length > 0 && (
        <ul aria-label="Reactions" className="flex flex-wrap gap-1">
          {groups.map((g) => {
            const names = [...(g.mine ? ['you'] : []), ...g.others.filter(Boolean)].join(', ');
            return (
              <li key={g.content}>
                <ChipButton pressed={g.mine} disabled={!canReact} label={`${names} reacted with ${NAMES[g.content] ?? g.content}${canReact ? (g.mine ? ' (remove yours)' : ' (add yours)') : ''}`} onClick={() => {
                  toggle(g.content, !g.mine);
                }}>
                  <span aria-hidden>{EMOJI[g.content] ?? `:${g.content}:`}</span>
                  {g.count}
                </ChipButton>
              </li>
            );
          })}
        </ul>
      )}
      {canReact && (
        <Menu>
          <MenuTrigger asChild><IconButton size="sm" icon={SmilePlus} label="Add a reaction"/></MenuTrigger>
          <MenuContent>
            {DEFAULTS.map((c) => (
              <MenuItem key={c} onSelect={() => {
                toggle(c, !mine.has(c));
              }}>
                <span aria-hidden>{EMOJI[c]}</span> {mine.has(c) ? `Remove ${NAMES[c] ?? c}` : NAMES[c] ?? c}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
});
