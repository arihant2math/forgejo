// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export const kinds = ['code', 'repositories', 'issues', 'pulls', 'users', 'organizations'] as const;
export type Kind = typeof kinds[number];
export interface DiscoverySearch {
  q: string;
  repoId?: number | undefined;
  type: Kind;
  sort: 'updated' | 'created' | 'alpha' | 'stars';
  state: 'all' | 'open' | 'closed';
  archived: '' | 'true' | 'false';
  language: string;
  page: number;
}

export function discoverySearch(s: Record<string, unknown>): DiscoverySearch {
  const type = kinds.includes(s.type as Kind) ? s.type as Kind : 'repositories';
  const sort = ['updated', 'created', 'alpha', 'stars'].includes(String(s.sort)) ? s.sort as DiscoverySearch['sort'] : 'updated';
  return {
    repoId: Number(s.repoId) > 0 ? Number(s.repoId) : undefined,
    q: typeof s.q === 'string' ? s.q.slice(0, 1000) : '', type,
    sort: type !== 'repositories' && sort === 'stars' || (type === 'issues' || type === 'pulls') && sort === 'alpha' ? 'updated' : sort,
    state: s.state === 'open' || s.state === 'closed' ? s.state : 'all',
    archived: s.archived === 'true' || s.archived === 'false' ? s.archived : '',
    language: typeof s.language === 'string' ? s.language.slice(0, 100) : '',
    page: Number.isSafeInteger(Number(s.page)) && Number(s.page) > 0 && Number(s.page) <= 100000 ? Number(s.page) : 1,
  };
}
