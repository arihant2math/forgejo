// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The local search index (PLAN §5.1: MiniSearch in a worker, over Comlink):
// issues and pull requests by title, repository and number, with prefix
// and typo-tolerant matching. The page feeds it from the pool (documents in
// batches, then changes) and asks it as the user types; indexing never
// blocks the page. The server's issue search covers what is not on this
// device (features/search).

import {expose} from 'comlink';
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

const index = new MiniSearch<SearchDoc>({
  fields: ['title', 'repo', 'num'],
  extractField: (doc, field) => (field === 'num' ? String(doc.number) : String(doc[field as keyof SearchDoc])),
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

const api = {
  /** Adds or replaces documents. */
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
    const hits = query.trim() ? index.search(query).slice(0, limit).map((r) => ({id: r.id as number, score: r.score})) : [];
    return {hits, ms: performance.now() - t0, size: index.documentCount};
  },
};

export type SearchApi = typeof api;

expose(api);
