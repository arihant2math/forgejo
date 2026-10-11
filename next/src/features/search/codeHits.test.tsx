// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {type Hit, matchRows} from './codeHits.ts';

const hl = (s: string) => `<span class="search-highlight">${s}</span>`;
const text = (runs: {text: string}[]) => runs.map((r) => r.text).join('');

// What git grep answers for `zoom` with one line of context (QA #248): matches marked, context lines not.
const config: Hit = {RepoID: 1, Filename: 'internal/config/config.go', CommitID: 'e2c2', Lines: [
  {Num: 10, FormattedContent: '<span class="kd">type</span> Config struct {'},
  {Num: 11, FormattedContent: `\tMax${hl('Zoom')} int`},
  {Num: 12, FormattedContent: '\tTimeout string'},
  {Num: 16, FormattedContent: 'func Default() Config {'},
  {Num: 17, FormattedContent: `\treturn Config{Max${hl('Zoom')}: 16}`},
  {Num: 18, FormattedContent: '}'},
]};
const projection: Hit = {RepoID: 1, Filename: 'internal/geo/projection.go', CommitID: 'e2c2', Lines: [
  {Num: 17, FormattedContent: ''},
  {Num: 18, FormattedContent: `func clamp(${hl('zoom')} int) int {`},
  {Num: 19, FormattedContent: `\tif ${hl('zoom')} &gt; 18 {`},
  {Num: 20, FormattedContent: '\t\treturn 18'},
]};

test('only matching lines are hits; the context goes with the hit it surrounds (#248)', () => {
  const rows = matchRows([config, projection]);
  expect(rows.map((r) => `${r.hit.Filename}:${String(r.line.num)}`)).toEqual([
    'internal/config/config.go:11', 'internal/config/config.go:17', 'internal/geo/projection.go:18', 'internal/geo/projection.go:19',
  ]);
  const [c11, c17, p18, p19] = rows;
  expect(c11?.before.map((l) => l.num)).toEqual([10]);
  expect(c11?.after.map((l) => l.num)).toEqual([12]);
  expect(c17?.before.map((l) => l.num)).toEqual([16]);
  expect(c17?.after.map((l) => l.num)).toEqual([18]);
  // A blank context line is shown with its hit, never a hit of its own; context between two hits goes with the first.
  expect(p18?.before.map((l) => l.num)).toEqual([17]);
  expect(p18?.after).toEqual([]);
  expect(p19?.after.map((l) => l.num)).toEqual([20]);
  // The words that matched stay marked; the markup is gone (text only).
  expect(c17?.line.runs).toEqual([{text: '\treturn Config{Max', marked: false}, {text: 'Zoom', marked: true}, {text: ': 16}', marked: false}]);
  expect(text(p19?.line.runs ?? [])).toBe('\tif zoom > 18 {');
});

test('a file without match markers has its non-blank lines as hits; context not next to a hit is dropped', () => {
  const rows = matchRows([{RepoID: 1, Filename: 'a.txt', CommitID: 'c', Lines: [{Num: 1, FormattedContent: 'one'}, {Num: 2, FormattedContent: '  '}, {Num: 3, FormattedContent: 'three'}]}]);
  expect(rows.map((r) => r.line.num)).toEqual([1, 3]);
  const gap = matchRows([{RepoID: 1, Filename: 'b.txt', CommitID: 'c', Lines: [{Num: 1, FormattedContent: 'far'}, {Num: 5, FormattedContent: 'near'}, {Num: 6, FormattedContent: hl('hit')}]}]);
  expect(gap.map((r) => [r.line.num, r.before.map((l) => l.num)])).toEqual([[6, [5]]]);
});
