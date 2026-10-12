// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Pool} from '../../data/pool.ts';
import type {Milestone, Project, Repository, User} from '../../protocol/types.gen.ts';
import {score, scoreNamed} from './search.ts';

export interface Hit<T> {
  item: T;
  score: number;
  repo?: Repository | undefined;
}

function top<T>(hits: Hit<T>[], limit: number): Hit<T>[] {
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Includes owner boards known only through a shared repository's ProjectRef. */
export type BoardHit = Pick<Project, 'id' | 'title' | 'closed'>;

/** Matches title and repository context; includes reference-only boards and prefers open boards on ties. */
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

/** Matches title and repository context; prefers open milestones on ties. */
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
