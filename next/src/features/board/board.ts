// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Unknown columns fall back to the default column, as in Forgejo.
// Replay pending moves in submission order: positions include earlier moves
// and exclude the moved card, matching the server's readable-card indexing.

import type {ProjectColumn} from '../../protocol/types.gen.ts';

export interface Card {
  issueId: number;
  column: number;
  sorting: number;
  /** ProjectIssue id (a stable tiebreak). */
  id: number;
}

export interface Move {
  column: number;
  position: number;
}

export interface BoardLayout {
  /** Columns in display order. */
  columns: ProjectColumn[];
  /** Card issue ids per column, in order. */
  cards: Map<number, number[]>;
  /** The default column (where cards without a column go). */
  defaultColumn: number | undefined;
}

export function orderColumns(columns: Iterable<ProjectColumn>): ProjectColumn[] {
  return [...columns].sort((a, b) => a.sorting - b.sorting || a.id - b.id);
}

/** `moves`: every pending move, in the order made ([card, move]; a card can be moved more than once). */
export function boardLayout(columns: Iterable<ProjectColumn>, cards: Iterable<Card>, moves: Iterable<readonly [number, Move]>, shown: (issueId: number) => boolean): BoardLayout {
  // Moved cards start in their server places: an earlier move's position was counted with them there.
  const pending = [...moves];
  const cols = orderColumns(columns);
  const defaultColumn = (cols.find((c) => c.default) ?? cols[0])?.id;
  const out = new Map<number, number[]>();
  for (const c of cols) out.set(c.id, []);
  const placed: Card[] = [];
  for (const c of cards) {
    if (!shown(c.issueId)) continue;
    placed.push(c);
  }
  placed.sort((a, b) => a.sorting - b.sorting || a.id - b.id);
  for (const c of placed) {
    const col = out.has(c.column) ? c.column : defaultColumn;
    if (col !== undefined) out.get(col)?.push(c.issueId);
  }
  for (const [issueId, m] of pending) {
    if (!shown(issueId)) continue;
    for (const l of out.values()) {
      const at = l.indexOf(issueId);
      if (at >= 0) l.splice(at, 1);
    }
    const list = out.get(m.column);
    if (!list) continue;
    list.splice(Math.max(0, Math.min(m.position, list.length)), 0, issueId);
  }
  return {columns: cols, cards: out, defaultColumn};
}

export function findCard(layout: BoardLayout, issueId: number): {column: number; index: number} | undefined {
  for (const [column, list] of layout.cards) {
    const index = list.indexOf(issueId);
    if (index >= 0) return {column, index};
  }
  return undefined;
}

/** Target gap includes the card; returned position excludes it. Undefined means no change. */
export function moveTo(layout: BoardLayout, issueId: number, column: number, index: number): Move | undefined {
  const from = findCard(layout, issueId);
  const list = layout.cards.get(column);
  if (!from || !list) return undefined;
  let position = Math.max(0, Math.min(index, list.length));
  if (from.column === column) {
    if (position === from.index || position === from.index + 1) return undefined;
    if (position > from.index) position--;
  }
  return {column, position};
}
