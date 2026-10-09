// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// More of what the ⌘K palette finds in the pool (beyond repositories and
// issues): boards, milestones and people, scored like everything else
// (search.ts `score`). Untracked by the caller; small stores, one pass each.

import type {Pool} from '../../data/pool.ts';
import type {Milestone, Project, Repository, User} from '../../protocol/types.gen.ts';
import {score, scoreNamed} from './search.ts';

export interface Hit<T> {
  item: T;
  score: number;
  /** The repository it belongs to, if any. */
  repo?: Repository | undefined;
}

function top<T>(hits: Hit<T>[], limit: number): Hit<T>[] {
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A board as the palette lists it: a Project, or the ProjectRef of an owner's board the device holds only by reference. */
export type BoardHit = Pick<Project, 'id' | 'title' | 'closed'>;

/**
 * Boards by title, the repository's name for further words (open ones first on a tie) — also a user's or an
 * organization's board known by its reference only (one shared with the viewer through a repository they read).
 */
export function searchBoards(pool: Pool, words: readonly string[], limit = 4): Hit<BoardHit>[] {
  const out: Hit<BoardHit>[] = [];
  for (const e of pool.model('Project').all()) {
    const p = e.data;
    const repo = pool.model('Repository').get(p.repo_id)?.data;
    const s = scoreNamed(p.title.toLowerCase(), (repo?.full_name ?? '').toLowerCase(), words);
    if (s >= 0) out.push({item: p, score: s + (p.closed ? 0 : 0.5), repo});
  }
  for (const e of pool.model('ProjectRef').all()) {
    const p = e.data;
    if (pool.model('Project').get(p.id)) continue;
    const s = scoreNamed(p.title.toLowerCase(), pool.model('User').get(p.owner_id)?.data.login.toLowerCase() ?? '', words);
    if (s >= 0) out.push({item: p, score: s + (p.closed ? 0 : 0.5)});
  }
  return top(out, limit);
}

/** Milestones by title, the repository's name for further words (open ones first on a tie), with their repository. */
export function searchMilestones(pool: Pool, words: readonly string[], limit = 4): Hit<Milestone>[] {
  const out: Hit<Milestone>[] = [];
  for (const e of pool.model('Milestone').all()) {
    const m = e.data;
    const repo = pool.model('Repository').get(m.repo_id)?.data;
    if (!repo) continue;
    const s = scoreNamed(m.title.toLowerCase(), repo.full_name.toLowerCase(), words);
    if (s >= 0) out.push({item: m, score: s + (m.state === 'open' ? 0.5 : 0), repo});
  }
  return top(out, limit);
}

/** People and organizations by login or name. */
export function searchPeople(pool: Pool, words: readonly string[], limit = 4): Hit<User>[] {
  const out: Hit<User>[] = [];
  for (const e of pool.model('User').all()) {
    const u = e.data;
    if (u.type !== 'user' && u.type !== 'organization') continue;
    const s = score(`${u.login} ${u.full_name}`.toLowerCase(), words);
    if (s >= 0) out.push({item: u, score: s});
  }
  return top(out, limit);
}
