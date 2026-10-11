// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code search results (B9 `GET …/search`, `/search/code`) as the hits a person picks from: a file's `Lines` are its
// matching lines and the context around them (git grep's, the indexer's), each line Forgejo's highlighted HTML in
// which the words that matched are in a `search-highlight` span. Only matching lines are hits; the context goes with
// the hit it surrounds.

import {markedTextOfMarkup} from '../../app/trusted.ts';

export interface HitLine {
  Num: number;
  FormattedContent: string;
}

/** One file of the answer. */
export interface Hit {
  RepoID: number;
  Filename: string;
  CommitID: string;
  Lines: HitLine[];
}

/** A line's text in runs, `marked`: the words that matched. */
export type Runs = {text: string; marked: boolean}[];

export interface ShownLine {
  num: number;
  runs: Runs;
}

/** A matching line (a hit: a row of the results) and the context lines shown with it. */
export interface MatchRow {
  hit: Hit;
  line: ShownLine;
  before: ShownLine[];
  after: ShownLine[];
}

/** The class Forgejo puts around the words that matched (modules/indexer/code HighlightSearchResultCode). */
export const MATCH_CLASS = 'search-highlight';

/**
 * The hits of an answer, in its order: each matching line with the context lines next to it (a context line between
 * two hits goes with the one above it). A file whose lines mark no match at all (an answer without the markers)
 * has its non-blank lines as hits, never a blank line.
 */
export function matchRows(hits: readonly Hit[]): MatchRow[] {
  const rows: MatchRow[] = [];
  for (const hit of hits) {
    const lines = [...hit.Lines].sort((a, b) => a.Num - b.Num).map((l) => {
      const runs = markedTextOfMarkup(l.FormattedContent, MATCH_CLASS);
      return {num: l.Num, runs, match: runs.some((r) => r.marked && r.text.trim() !== '')};
    });
    const anyMatch = lines.some((l) => l.match);
    let pending: ShownLine[] = [];
    let last: MatchRow | undefined;
    for (const l of lines) {
      const shown = {num: l.num, runs: l.runs};
      const match = anyMatch ? l.match : l.runs.some((r) => r.text.trim() !== '');
      if (match) {
        last = {hit, line: shown, before: adjoining(pending, l.num), after: []};
        rows.push(last);
        pending = [];
      } else if (anyMatch && last && l.num === (last.after.at(-1)?.num ?? last.line.num) + 1) {
        last.after.push(shown);
      } else if (anyMatch) {
        pending.push(shown);
      }
    }
  }
  return rows;
}

/** The lines of `pending` that run without a gap up to line `num` (the context right above it). */
function adjoining(pending: ShownLine[], num: number): ShownLine[] {
  let from = pending.length;
  while (from > 0 && pending[from - 1]?.num === num - (pending.length - from) - 1) from--;
  return pending.slice(from);
}
