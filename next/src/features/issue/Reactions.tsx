// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useRef, useState} from 'react';
import {useApp, useSession} from '../../app/store.ts';
import {isTemp} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import {viewMembers} from '../../intents/view.ts';
import {useOverlay, usePool} from '../issues/cells.tsx';
import {SmileyIcon} from '@primer/octicons-react';
import {AnchoredOverlay, Button, FocusKeys, IconButton} from '@primer/react';

/** Forgejo's default [ui] REACTIONS; other (custom) ones show by name. */
const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', 'laugh': '😄', 'hooray': '🎉', 'confused': '😕', 'heart': '❤️', 'rocket': '🚀', 'eyes': '👀',
};
const NAMES: Record<string, string> = {
  '+1': 'Thumbs up', '-1': 'Thumbs down', 'laugh': 'Laugh', 'hooray': 'Hooray', 'confused': 'Confused', 'heart': 'Heart', 'rocket': 'Rocket', 'eyes': 'Eyes',
};
const DEFAULTS = Object.keys(EMOJI);

/** GitHub's fixed order; custom reactions follow by name. */
const order = (content: string) => {
  const i = DEFAULTS.indexOf(content);
  return i < 0 ? DEFAULTS.length : i;
};

export const Reactions = observer(function Reactions({issueId, commentId}: {issueId: number; commentId: number}) {
  const app = useApp();
  const addButton = useRef<HTMLButtonElement>(null);
  const pool = usePool();
  const overlay = useOverlay();
  const me = useSession().userId;
  const rows = pool.model('Reaction').by(commentId ? 'comment_id' : 'issue_id', commentId || issueId);
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
      .sort((a, b) => order(a.content) - order(b.content) || a.content.localeCompare(b.content));
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
    <div className="flex flex-wrap items-center gap-2">
      {canReact && <ReactionPicker mine={mine} anchor={addButton} onToggle={toggle}/>}
      {groups.length > 0 && (
        <ul aria-label="Reactions" className="flex flex-wrap gap-2">
          {groups.map((g) => {
            const names = [...(g.mine ? ['you'] : []), ...g.others.filter(Boolean)].join(', ');
            return (
              <li key={g.content}>
                <Button size="small" count={g.count} aria-pressed={g.mine} disabled={!canReact} aria-label={`${names} reacted with ${NAMES[g.content] ?? g.content}${canReact ? (g.mine ? ' (remove yours)' : ' (add yours)') : ''}`} onClick={() => {
                  if (g.mine && g.count === 1) addButton.current?.focus({preventScroll: true});
                  toggle(g.content, !g.mine);
                }}>
                  <span aria-hidden>{EMOJI[g.content] ?? `:${g.content}:`}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

/** GitHub's picker: one row of the eight reactions, each a toggle. */
function ReactionPicker({mine, anchor, onToggle}: {mine: ReadonlySet<unknown>; anchor: RefObject<HTMLButtonElement | null>; onToggle: (content: string, add: boolean) => void}) {
  const [open, setOpen] = useState(false);
  return (
    <AnchoredOverlay open={open} onOpen={() => { setOpen(true); }} onClose={() => { setOpen(false); }} anchorRef={anchor}
      focusZoneSettings={{bindKeys: FocusKeys.ArrowHorizontal | FocusKeys.HomeAndEnd}} overlayProps={{role: 'dialog', 'aria-label': 'Pick a reaction'}}
      renderAnchor={(props) => <IconButton {...props} ref={anchor} icon={SmileyIcon} variant="invisible" size="small" aria-label="Add a reaction" type="button"/>}>
      <div className="flex gap-1 p-2">
        {DEFAULTS.map((c) => (
          <Button key={c} variant="invisible" size="small" aria-pressed={mine.has(c)} aria-label={NAMES[c] ?? c} type="button" onClick={() => {
            onToggle(c, !mine.has(c));
            setOpen(false);
          }}><span aria-hidden>{EMOJI[c]}</span></Button>
        ))}
      </div>
    </AnchoredOverlay>
  );
}
