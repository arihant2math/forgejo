// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {findFiles, fuzzyMatch, markRuns, normalizeQuery} from './fuzzy.ts';

const match = (path: string, q: string) => fuzzyMatch(path, path.toLowerCase(), normalizeQuery(q));
const order = (paths: string[], q: string) => findFiles(paths, q, 10).hits.map((h) => h.path);

describe('fuzzy file matching', () => {
  test('the query\'s letters in order, case-insensitive, whitespace ignored', () => {
    expect(match('README.md', 'rdme')?.marks).toEqual([0, 3, 4, 5]);
    expect(match('src/app/App.tsx', 'src app')?.marks).toEqual([0, 1, 2, 4, 5, 6]);
    expect(match('README.md', 'mdr')).toBeUndefined();
    expect(match('a', 'ab')).toBeUndefined();
    expect(normalizeQuery(' Src  App ')).toBe('srcapp');
  });

  test('a match in the file\'s name beats one over directories; the exact name and its start first', () => {
    expect(order(['app/main.go', 'src/App.tsx'], 'app')).toEqual(['src/App.tsx', 'app/main.go']);
    expect(order(['tools/Makefile.old', 'deep/dir/Makefile', 'src/make_files.go'], 'makefile')).toEqual(['deep/dir/Makefile', 'tools/Makefile.old', 'src/make_files.go']);
    // Word starts (camelCase, separators) and consecutive letters: "rm" is RefMenu's, not "form".
    expect(order(['src/form.ts', 'src/RefMenu.tsx'], 'rm')[0]).toBe('src/RefMenu.tsx');
    // The shortest stretch is marked: "ab" in "a-x-ab" is the last two letters.
    expect(match('a-x-ab', 'ab')?.marks).toEqual([4, 5]);
  });

  test('shorter paths win ties; at most `limit`, best first', () => {
    expect(order(['a/b/c/index.ts', 'index.ts', 'x/index.ts'], 'index')).toEqual(['index.ts', 'x/index.ts', 'a/b/c/index.ts']);
    const many = Array.from({length: 500}, (_, i) => `pkg/m${String(i)}/file.go`);
    const {hits} = findFiles(many, 'file', 25);
    expect(hits).toHaveLength(25);
    for (let i = 1; i < hits.length; i++) expect((hits[i - 1]?.score ?? 0) >= (hits[i]?.score ?? 0)).toBe(true);
  });

  test('an empty query lists the first paths in their order', () => {
    expect(findFiles(['b', 'a', 'c'], '  ', 2).hits.map((h) => h.path)).toEqual(['b', 'a']);
  });

  test('a query that extends the previous one rescans only its matches, with the same answer as a full scan', () => {
    const paths = ['src/app/App.tsx', 'src/app/api.ts', 'src/code/fuzzy.ts', 'README.md', 'next/src/app/palette/files.ts'];
    const first = findFiles(paths, 'ap', 10);
    expect(first.state.matched).toEqual([0, 1, 4]);
    const narrowed = findFiles(paths, 'app', 10, first.state);
    expect(narrowed.hits).toEqual(findFiles(paths, 'app', 10).hits);
    // Not an extension (or another list): a full scan.
    expect(findFiles(paths, 'fz', 10, first.state).hits.map((h) => h.path)).toEqual(['src/code/fuzzy.ts']);
    expect(findFiles(['fuzzy'], 'apfz', 10, {...first.state, query: 'ap'}).hits).toEqual([]);
  });

  test('marks cut a path into runs', () => {
    expect(markRuns('README.md', [0, 3, 4, 5])).toEqual([
      {text: 'R', marked: true}, {text: 'EA', marked: false}, {text: 'DME', marked: true}, {text: '.md', marked: false},
    ]);
    expect(markRuns('ab', [])).toEqual([{text: 'ab', marked: false}]);
  });

  test('a large tree is searched quickly', () => {
    const paths = Array.from({length: 50_000}, (_, i) => `services/area${String(i % 97)}/module${String(i)}/handler_${String(i % 13)}.go`);
    const t0 = performance.now();
    const a = findFiles(paths, 'h', 50);
    const b = findFiles(paths, 'ha', 50, a.state);
    findFiles(paths, 'han', 50, b.state);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(a.hits).toHaveLength(50);
  });
});
