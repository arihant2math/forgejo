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
});
