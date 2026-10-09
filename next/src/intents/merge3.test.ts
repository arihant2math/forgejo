// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import {describe, expect, test} from 'vitest';
import {hasConflictMarkers, MARK_MINE, MARK_SPLIT, MARK_THEIRS, merge3} from './merge3.ts';

const lines = (...l: string[]) => l.join('\n');

describe('merge3', () => {
  test('one side changed: that side', () => {
    expect(merge3('a\nb', 'a\nb', 'a\nB')).toEqual({clean: true, text: 'a\nB', conflicts: 0});
    expect(merge3('a\nb', 'a\nB', 'a\nb')).toEqual({clean: true, text: 'a\nB', conflicts: 0});
  });

  test('both changed the same way: once', () => {
    expect(merge3('a\nb', 'a\nX', 'a\nX').text).toBe('a\nX');
  });

  test('changes in different places merge cleanly', () => {
    const base = lines('title', '', 'one', 'two', 'three', 'four', 'five');
    const theirs = lines('title', '', 'ONE', 'two', 'three', 'four', 'five');
    const mine = lines('title', '', 'one', 'two', 'three', 'four', 'FIVE', 'six');
    expect(merge3(base, theirs, mine)).toEqual({clean: true, text: lines('title', '', 'ONE', 'two', 'three', 'four', 'FIVE', 'six'), conflicts: 0});
  });

  test('a deletion on one side and an edit elsewhere on the other', () => {
    expect(merge3(lines('a', 'b', 'c', 'd'), lines('a', 'c', 'd'), lines('a', 'b', 'c', 'D')).text).toBe(lines('a', 'c', 'D'));
  });

  test('the same lines changed differently: a conflict with markers (mine first)', () => {
    const r = merge3(lines('a', 'b', 'c'), lines('a', 'THEIRS', 'c'), lines('a', 'MINE', 'c'));
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(lines('a', MARK_MINE, 'MINE', MARK_SPLIT, 'THEIRS', MARK_THEIRS, 'c'));
    expect(hasConflictMarkers(r.text)).toBe(true);
    expect(hasConflictMarkers('a <<<<<<< b')).toBe(false);
  });

  test('insertions at the same place conflict; empty texts work', () => {
    expect(merge3('x', 'A\nx', 'B\nx').clean).toBe(false);
    expect(merge3('', 'a', '')).toEqual({clean: true, text: 'a', conflicts: 0});
    expect(merge3('', '', 'b').text).toBe('b');
  });

  test('properties: identities, and every line each side added survives a clean merge', () => {
    const text = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', ''), {maxLength: 12}).map((l) => l.join('\n'));
    fc.assert(fc.property(text, text, (base, x) => {
      expect(merge3(base, base, x).text).toBe(x);
      expect(merge3(base, x, base).text).toBe(x);
      expect(merge3(base, x, x).text).toBe(x);
    }));
    // Unique inserted lines on each side: a clean merge keeps both sides' lines.
    const ops = fc.array(fc.nat(10), {maxLength: 4});
    fc.assert(fc.property(text, ops, ops, (base, ins1, ins2) => {
      const insert = (tag: string, at: number[]) => {
        const l = base.split('\n');
        at.forEach((p, k) => l.splice(p % (l.length + 1), 0, `${tag}${String(k)}`));
        return l.join('\n');
      };
      const theirs = insert('T', ins1);
      const mine = insert('M', ins2);
      const r = merge3(base, theirs, mine);
      const out = r.text.split('\n');
      for (const t of [...theirs.split('\n'), ...mine.split('\n')].filter((l) => /^[TM]\d$/.test(l))) {
        expect(out.filter((l) => l === t)).toHaveLength(1);
      }
    }));
  });

  test('large texts beyond the LCS budget conflict whole unless one side is unchanged', () => {
    const big = Array.from({length: 3000}, (_, k) => `line ${String(k)}`);
    const theirs = [...big];
    theirs[0] = 'T';
    const mine = [...big];
    mine[2999] = 'M';
    // Prefix/suffix trimming keeps this cheap: a clean merge.
    expect(merge3(big.join('\n'), theirs.join('\n'), mine.join('\n')).text).toBe([...theirs.slice(0, 2999), 'M'].join('\n'));
  });
});
