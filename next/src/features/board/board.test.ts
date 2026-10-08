// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import {describe, expect, test} from 'vitest';
import {Overlay} from '../../intents/overlay.ts';
import type {ProjectColumn} from '../../protocol/types.gen.ts';
import {T} from '../../test/fakeSession.ts';
import {boardLayout, type Card, findCard, type Move, moveTo, orderColumns} from './board.ts';

const col = (id: number, sorting: number, extra: Partial<ProjectColumn> = {}): ProjectColumn => ({
  id, project_id: 1, title: `C${String(id)}`, default: false, sorting, color: '', creator_id: 1, created_at: T, updated_at: T, ...extra,
});
const card = (issueId: number, column: number, sorting: number): Card => ({issueId, column, sorting, id: issueId * 10});
const all = () => true;
const cols = [col(10, 2), col(11, 1, {default: true}), col(12, 3)];

describe('boardLayout', () => {
  test('columns by sorting; cards by sorting; unknown and 0 columns in the default', () => {
    const l = boardLayout(cols, [card(1, 10, 2), card(2, 10, 1), card(3, 0, 0), card(4, 99, 5), card(5, 12, 0)], new Map(), all);
    expect(l.columns.map((c) => c.id)).toEqual([11, 10, 12]);
    expect(l.defaultColumn).toBe(11);
    expect(l.cards.get(10)).toEqual([2, 1]);
    expect(l.cards.get(11)).toEqual([3, 4]);
    expect(l.cards.get(12)).toEqual([5]);
  });

  test('without a default column, the first is', () => {
    expect(boardLayout([col(5, 2), col(6, 1)], [card(1, 0, 0)], new Map(), all).cards.get(6)).toEqual([1]);
  });

  test('cards not on this device are left out', () => {
    const l = boardLayout(cols, [card(1, 10, 1), card(2, 10, 2)], new Map(), (id) => id !== 1);
    expect(l.cards.get(10)).toEqual([2]);
  });

  test('pending moves: the card at its position in the target column', () => {
    const cards = [card(1, 10, 1), card(2, 10, 2), card(3, 12, 1), card(4, 12, 2)];
    const moves = new Map<number, Move>([[1, {column: 12, position: 1}]]);
    const l = boardLayout(cols, cards, moves, all);
    expect(l.cards.get(10)).toEqual([2]);
    expect(l.cards.get(12)).toEqual([3, 1, 4]);
    // Past the end: last.
    expect(boardLayout(cols, cards, new Map([[1, {column: 12, position: 50}]]), all).cards.get(12)).toEqual([3, 4, 1]);
  });

  test('several pending moves: replayed in the order made, each against the layout the earlier ones left (as B9 applies them in turn)', () => {
    const cards = [card(10, 12, 1), card(11, 12, 2), card(12, 12, 3), card(13, 12, 4), card(20, 10, 1), card(21, 10, 2)];
    // 20 to gap 3 of [10,11,12,13], then 21 to gap 1 of [10,11,12,20,13].
    const first = moveTo(boardLayout(cols, cards, new Map(), all), 20, 12, 3) ?? {column: 0, position: -1};
    expect(first).toEqual({column: 12, position: 3});
    const after1 = boardLayout(cols, cards, new Map([[20, first]]), all);
    expect(after1.cards.get(12)).toEqual([10, 11, 12, 20, 13]);
    const second = moveTo(after1, 21, 12, 1) ?? {column: 0, position: -1};
    const both = boardLayout(cols, cards, new Map([[20, first], [21, second]]), all);
    // The server, applying the positions one after the other to [10,11,12,13]:
    const server = [10, 11, 12, 13];
    server.splice(first.position, 0, 20);
    server.splice(second.position, 0, 21);
    expect(both.cards.get(12)).toEqual(server);
    expect(both.cards.get(12)).toEqual([10, 21, 11, 12, 20, 13]);
  });

  test('a card moved twice while another move is pending: every move replayed in order, as the server does', () => {
    const cards = [card(10, 12, 1), card(11, 12, 2), card(20, 10, 1), card(21, 10, 2)];
    const moves: [number, Move][] = [[20, {column: 12, position: 0}], [21, {column: 12, position: 2}], [20, {column: 12, position: 3}]];
    const server = [10, 11];
    for (const [id, m] of moves) {
      const at = server.indexOf(id);
      if (at >= 0) server.splice(at, 1);
      server.splice(m.position, 0, id);
    }
    expect(boardLayout(cols, cards, moves, all).cards.get(12)).toEqual(server);
    expect(server).toEqual([10, 21, 11, 20]);
  });

  test('property: the layout with pending moves equals the server applying them in turn (B9), whatever moved before', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 2}), fc.integer({min: 0, max: 20})), {minLength: 1, maxLength: 10}),
      fc.array(fc.tuple(fc.nat(), fc.integer({min: 0, max: 2}), fc.nat()), {minLength: 1, maxLength: 6}),
      (placed, steps) => {
        const ids = [10, 11, 12];
        const cards = placed.map(([c, s], i) => card(i + 1, ids[c] ?? 10, s));
        const moves: [number, Move][] = [];
        // The server: the columns as they are, each move applied in turn (remove, insert at position).
        const server = new Map(boardLayout(cols, cards, [], all).cards);
        for (const [pick, target, gapSeed] of steps) {
          const before = boardLayout(cols, cards, moves, all);
          const issueId = cards[pick % cards.length]?.issueId ?? 1;
          const column = ids[target] ?? 10;
          const n = before.cards.get(column)?.length ?? 0;
          const m = moveTo(before, issueId, column, gapSeed % (n + 1));
          if (!m) continue;
          moves.push([issueId, m]);
          for (const l of server.values()) {
            const at = l.indexOf(issueId);
            if (at >= 0) l.splice(at, 1);
          }
          server.get(m.column)?.splice(m.position, 0, issueId);
          expect(boardLayout(cols, cards, moves, all).cards).toEqual(server);
        }
      },
    ), {numRuns: 2000});
  });

  test('a move whose echo arrived while its layer is still pending shows once, where it went', () => {
    // 20 moved to the top of column 12; the server already says so (sorting 0); the layer is still there.
    const cards = [card(10, 12, 1), card(11, 12, 2), card(20, 12, 0)];
    expect(boardLayout(cols, cards, [[20, {column: 12, position: 0}]], all).cards.get(12)).toEqual([20, 10, 11]);
  });

  test('a move into a column that is gone leaves the card out until the server answers', () => {
    const l = boardLayout(cols, [card(1, 10, 1)], new Map([[1, {column: 77, position: 0}]]), all);
    expect([...l.cards.values()].flat()).toEqual([]);
  });
});

describe('moveTo', () => {
  const l = boardLayout(cols, [card(1, 10, 1), card(2, 10, 2), card(3, 10, 3), card(4, 12, 1)], new Map(), all);
  test('within a column: gaps around the card change nothing; positions leave the card out', () => {
    expect(moveTo(l, 1, 10, 0)).toBeUndefined();
    expect(moveTo(l, 1, 10, 1)).toBeUndefined();
    expect(moveTo(l, 1, 10, 2)).toEqual({column: 10, position: 1});
    expect(moveTo(l, 1, 10, 3)).toEqual({column: 10, position: 2});
    expect(moveTo(l, 3, 10, 0)).toEqual({column: 10, position: 0});
  });
  test('to another column', () => {
    expect(moveTo(l, 2, 12, 0)).toEqual({column: 12, position: 0});
    expect(moveTo(l, 2, 12, 9)).toEqual({column: 12, position: 1});
    expect(moveTo(l, 9, 12, 0)).toBeUndefined();
    expect(moveTo(l, 2, 99, 0)).toBeUndefined();
  });

  test('property: the moved card lands in the gap it was dropped in, the others keep their order', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 2}), fc.integer({min: 0, max: 20})), {minLength: 1, maxLength: 12}),
      fc.nat(), fc.integer({min: 0, max: 2}), fc.nat(),
      (placed, pick, target, gapSeed) => {
        const ids = [10, 11, 12];
        const cards = placed.map(([c, s], i) => card(i + 1, ids[c] ?? 10, s));
        const before = boardLayout(cols, cards, new Map(), all);
        const issueId = cards[pick % cards.length]?.issueId ?? 1;
        const column = ids[target] ?? 10;
        const n = before.cards.get(column)?.length ?? 0;
        const gap = gapSeed % (n + 1);
        const m = moveTo(before, issueId, column, gap);
        const from = findCard(before, issueId);
        if (!m || !from) {
          expect(from?.column === column && (gap === from.index || gap === from.index + 1)).toBe(true);
          return;
        }
        const after = boardLayout(cols, cards, new Map([[issueId, m]]), all);
        const list = after.cards.get(column) ?? [];
        // Where it shows: the gap, counted without the card when it came from above in the same column.
        const want = from.column === column && gap > from.index ? gap - 1 : gap;
        expect(list.indexOf(issueId)).toBe(want);
        const others = (l: typeof before) => [...l.cards.values()].flat().filter((x) => x !== issueId);
        expect(others(after).sort()).toEqual(others(before).sort());
        expect(list.filter((x) => x !== issueId)).toEqual((before.cards.get(column) ?? []).filter((x) => x !== issueId));
      },
    ));
  });
});

test('orderColumns: sorting, then id', () => {
  expect(orderColumns([col(3, 1), col(1, 1), col(2, 0)]).map((c) => c.id)).toEqual([2, 1, 3]);
});

test('Overlay.fieldOverrides: the top layer per entity, reacting to every change', () => {
  const o = new Overlay();
  o.add('a', [{t: 'field', model: 'Issue', id: 1, field: '~board:7', value: {column: 1, position: 0}}]);
  o.add('b', [{t: 'field', model: 'Issue', id: 1, field: '~board:7', value: {column: 2, position: 3}}]);
  o.add('c', [{t: 'field', model: 'Issue', id: 2, field: '~board:8', value: {column: 5, position: 0}}]);
  o.add('d', [{t: 'field', model: 'Notification', id: 1, field: 'status', value: 'read'}]);
  expect([...o.fieldOverrides('Issue', '~board:7')]).toEqual([[1, {column: 2, position: 3}]]);
  o.remove('b');
  expect([...o.fieldOverrides('Issue', '~board:7')]).toEqual([[1, {column: 1, position: 0}]]);
  expect([...o.fieldOverrides('Notification', 'status')]).toEqual([[1, 'read']]);
  // In the order made.
  o.add('e', [{t: 'field', model: 'Issue', id: 9, field: '~board:7', value: {column: 3, position: 0}}]);
  o.add('f', [{t: 'field', model: 'Issue', id: 1, field: '~board:7', value: {column: 4, position: 1}}]);
  expect([...o.fieldOverrides('Issue', '~board:7').keys()]).toEqual([9, 1]);
});
