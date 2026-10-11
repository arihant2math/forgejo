// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import type {Lang} from '../code/lang.ts';
import {CHUNK, highlight, SYN} from './highlight.ts';

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/** Line i's (length, class) pairs. */
function line(h: {spans: Uint32Array; starts: Uint32Array}, i: number): number[] {
  return [...h.spans.subarray(2 * (h.starts[i] ?? 0), 2 * (h.starts[i + 1] ?? 0))];
}

// The worker tokenizes a chunk of lines at a time (progress for the page's watchdog): the grammar's state crosses
// chunk boundaries, so the result is the same as tokenizing the whole text at once.
test('a text tokenized in chunks highlights as the whole text at once', {timeout: 60_000}, async () => {
  const goRaw = ['package main', '', 'var s = `raw', ...Array.from({length: 30}, (_, i) => `still raw ${String(i)}`), 'end`', 'func main() {}'].join('\n');
  const texts: [string, Lang][] = [
    [here('./highlight.ts'), 'typescript'],
    [here('../features/code/Src.tsx'), 'tsx'],
    [goRaw, 'go'],
    [`# Title\n\n\`\`\`go\n${Array.from({length: 20}, () => 'func x() {}').join('\n')}\n\`\`\`\n\ntext\n`, 'markdown'],
  ];
  for (const [text, lang] of texts) {
    const whole = await highlight(text, lang, undefined, Infinity);
    for (const chunk of [CHUNK, 3]) {
      let reports = 0;
      const h = await highlight(text, lang, () => {
        reports++;
      }, chunk);
      expect(h, `${lang} by ${String(chunk)}`).toEqual(whole);
      expect(reports).toBe(Math.ceil(text.split('\n').length / chunk));
    }
  }
});

test('state carried over a chunk boundary: a block comment opened before it colours the lines after it', async () => {
  const lines = Array.from({length: CHUNK + 20}, (_, i) => `const v${String(i)} = ${String(i)};`);
  lines[CHUNK - 2] = '/* a comment';
  lines[CHUNK - 1] = '';
  lines[CHUNK] = 'still the comment';
  lines[CHUNK + 1] = '*/';
  const h = await highlight(lines.join('\n'), 'typescript');
  if (!h) throw new Error('not highlighted');
  expect(line(h, CHUNK)).toEqual(['still the comment'.length, SYN.comment]);
  // Lines stay aligned: the line after the comment starts with its keyword.
  expect(line(h, CHUNK + 2).slice(0, 2)).toEqual([5, SYN.keyword]);
});
