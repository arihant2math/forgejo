// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {markedTextOfMarkup} from '../../app/trusted.ts';
import type {Mark} from '../../code/parts.tsx';

export interface HitLine {
  Num: number;
  FormattedContent: string;
}

export interface Hit {
  RepoID: number;
  Filename: string;
  CommitID: string;
  Lines: HitLine[];
}

export interface ShownLine {
  num: number;
  text: string;
  /** The search matches in text. */
  marks: Mark[];
}

export interface MatchRow {
  hit: Hit;
  line: ShownLine;
  before: ShownLine[];
  after: ShownLine[];
}

export const MATCH_CLASS = 'search-highlight';

/** Shared context belongs to the preceding hit; unmarked files use non-blank lines as hits. */
export function matchRows(hits: readonly Hit[]): MatchRow[] {
  const rows: MatchRow[] = [];
  for (const hit of hits) {
    const lines = [...hit.Lines].sort((a, b) => a.Num - b.Num).map((l) => {
      const runs = markedTextOfMarkup(l.FormattedContent, MATCH_CLASS);
      const marks: Mark[] = [];
      let at = 0;
      for (const r of runs) {
        if (r.marked) marks.push({from: at, to: at + r.text.length});
        at += r.text.length;
      }
      return {num: l.Num, text: runs.map((r) => r.text).join(''), marks, match: runs.some((r) => r.marked && r.text.trim() !== '')};
    });
    const anyMatch = lines.some((l) => l.match);
    let pending: ShownLine[] = [];
    let last: MatchRow | undefined;
    for (const l of lines) {
      const shown = {num: l.num, text: l.text, marks: l.marks};
      const match = anyMatch ? l.match : l.text.trim() !== '';
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

function adjoining(pending: ShownLine[], num: number): ShownLine[] {
  let from = pending.length;
  while (from > 0 && pending[from - 1]?.num === num - (pending.length - from) - 1) from--;
  return pending.slice(from);
}
