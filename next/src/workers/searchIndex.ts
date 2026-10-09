// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The local search index itself (MiniSearch), apart from the worker's
// messaging (search.worker.ts) so that it is tested and measured directly.

import MiniSearch from 'minisearch';

export interface SearchDoc {
  id: number;
  title: string;
  /** The repository's full name ("owner/repo"). */
  repo: string;
  number: number;
}

export interface SearchHit {
  id: number;
  score: number;
}

export interface SearchAnswer {
  hits: SearchHit[];
  /** Time spent searching in the worker (ms). */
  ms: number;
  size: number;
}

export function createIndex() {
  const index = new MiniSearch<SearchDoc>({
    fields: ['title', 'repo', 'num'],
    // Also asked for the id: keep it a number (hits, has/replace).
    extractField: (doc, field) => (field === 'id' ? doc.id : field === 'num' ? String(doc.number) : String(doc[field as keyof SearchDoc])),
    // Words in titles, and the parts of "owner/repo" (split on the slash, dashes and dots too).
    tokenize: (text) => text.split(/[\s/\-._:#,;!?()[\]{}"'`]+/u).filter(Boolean),
    searchOptions: {
      boost: {title: 3, num: 2},
      prefix: true,
      // A typo per five letters; none in short words (numbers, "ui").
      fuzzy: (term) => (term.length > 3 ? 0.2 : false),
      combineWith: 'AND',
    },
  });
  return {
    /** Adds or replaces documents; returns the number indexed. */
    upsert(docs: SearchDoc[]): number {
      for (const d of docs) {
        if (index.has(d.id)) index.replace(d);
        else index.add(d);
      }
      return index.documentCount;
    },
    remove(ids: number[]): number {
      for (const id of ids) if (index.has(id)) index.discard(id);
      return index.documentCount;
    },
    search(query: string, limit: number): SearchAnswer {
      const t0 = performance.now();
      // "#12" is the number 12.
      const q = query.replace(/(^|\s)#(\d)/g, '$1$2');
      const hits = q.trim() ? index.search(q).slice(0, limit).map((r) => ({id: r.id as number, score: r.score})) : [];
      return {hits, ms: performance.now() - t0, size: index.documentCount};
    },
  };
}

export type SearchApi = ReturnType<typeof createIndex>;
