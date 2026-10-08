// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A project board's layout (pure): its columns in order and each column's
// cards as the user sees them — the server's placement (ProjectIssue:
// column, sorting), with pending card moves (`board.move` intents, the
// overlay's `~board:<project>` field: column + position) on top.
//
// A card whose column is unknown or 0 sits in the default column, as in
// Forgejo. A move's `position` is the index among the cards the user saw in
// the target column, the moved card left out (B9 applies it the same way to
// the readable cards).

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

/** Columns ordered as Forgejo orders them (sorting, then id). */
export function orderColumns(columns: Iterable<ProjectColumn>): ProjectColumn[] {
  return [...columns].sort((a, b) => a.sorting - b.sorting || a.id - b.id);
}

export function boardLayout(columns: Iterable<ProjectColumn>, cards: Iterable<Card>, moves: ReadonlyMap<number, Move>, shown: (issueId: number) => boolean): BoardLayout {
  const cols = orderColumns(columns);
  const defaultColumn = (cols.find((c) => c.default) ?? cols[0])?.id;
  const out = new Map<number, number[]>();
  for (const c of cols) out.set(c.id, []);
  const placed: Card[] = [];
  for (const c of cards) {
    if (moves.has(c.issueId) || !shown(c.issueId)) continue;
    placed.push(c);
  }
  placed.sort((a, b) => a.sorting - b.sorting || a.id - b.id);
  for (const c of placed) {
    const col = out.has(c.column) ? c.column : defaultColumn;
    if (col !== undefined) out.get(col)?.push(c.issueId);
  }
  // Pending moves, lowest position first, so that several moves into one column keep their places.
  const pending = [...moves].filter(([issueId, m]) => shown(issueId) && out.has(m.column)).sort((a, b) => a[1].position - b[1].position || a[0] - b[0]);
  for (const [issueId, m] of pending) {
    const list = out.get(m.column);
    if (!list) continue;
    list.splice(Math.max(0, Math.min(m.position, list.length)), 0, issueId);
  }
  return {columns: cols, cards: out, defaultColumn};
}

/** Where a card is in a layout. */
export function findCard(layout: BoardLayout, issueId: number): {column: number; index: number} | undefined {
  for (const [column, list] of layout.cards) {
    const index = list.indexOf(issueId);
    if (index >= 0) return {column, index};
  }
  return undefined;
}

/**
 * The move that puts `issueId` at `index` of `column` as the layout shows it
 * (`index` counted with the card itself still in place when the column is
 * its own), or undefined when nothing changes. The result's position leaves
 * the card out.
 */
export function moveTo(layout: BoardLayout, issueId: number, column: number, index: number): Move | undefined {
  const from = findCard(layout, issueId);
  const list = layout.cards.get(column);
  if (!from || !list) return undefined;
  let position = Math.max(0, Math.min(index, list.length));
  if (from.column === column) {
    // Dropping into the gap just above or below itself changes nothing.
    if (position === from.index || position === from.index + 1) return undefined;
    if (position > from.index) position--;
  }
  return {column, position};
}
