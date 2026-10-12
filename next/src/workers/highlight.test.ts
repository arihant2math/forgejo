// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {type Lang, LIMITS, synClass, SYNTAX} from '../code/shiki.ts';
import {highlight, type Highlight, pack} from './highlight.ts';

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const style = (token: string) => SYNTAX.findIndex(([t]) => t === token);

/** Line i's (length, class code) pairs. */
function line(h: Highlight, i: number): number[] {
  return [...h.spans.subarray(2 * (h.starts[i] ?? 0), 2 * (h.starts[i + 1] ?? 0))];
}

/** Line i as [text, classes] runs. */
function runs(h: Highlight, text: string, i: number): [string, string][] {
  const src = text.split('\n')[i] ?? '';
  const pairs = line(h, i);
  const out: [string, string][] = [];
  let at = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    out.push([src.slice(at, at + (pairs[k] ?? 0)), synClass(pairs[k + 1] ?? 0)]);
    at += pairs[k] ?? 0;
  }
  return out;
}

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
    for (const chunk of [LIMITS.chunk, 3]) {
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
  const chunk = LIMITS.chunk;
  const lines = Array.from({length: chunk + 20}, (_, i) => `const v${String(i)} = ${String(i)};`);
  lines[chunk - 2] = '/* a comment';
  lines[chunk - 1] = '';
  lines[chunk] = 'still the comment';
  lines[chunk + 1] = '*/';
  const h = await highlight(lines.join('\n'), 'typescript');
  if (!h) throw new Error('not highlighted');
  expect(line(h, chunk)).toEqual(['still the comment'.length, style('comment')]);
  expect(line(h, chunk + 2).slice(0, 2)).toEqual([5, style('keyword')]);
});

test('lengths add up to each line (a trailing \\r stays plain); unknown languages are plain', async () => {
  const text = '{\n  "a": 1, // x\n  "b": "s"\n}\r';
  const h = await highlight(text, 'jsonc');
  if (!h) throw new Error('not highlighted');
  const lines = text.split('\n');
  expect(h.starts.length).toBe(lines.length + 1);
  lines.forEach((l, i) => {
    expect(line(h, i).filter((_, k) => k % 2 === 0).reduce((a, b) => a + b, 0), `line ${String(i)}`).toBe(l.length);
  });
  expect(runs(h, text, 1)).toContainEqual(['// x', 'text-syntax-comment']);
  expect(runs(h, text, 2)).toContainEqual(['"s"', 'text-syntax-string']);
  expect(await highlight('x', undefined)).toBeNull();
});

test('GitHub\'s scopes beyond the basic eight: tags, imports, regexps, headings, emphasis, diff markup', async () => {
  const tsx = 'import {a} from "b";\nconst r = /a\\.b/;\nconst el = <div>{a}</div>;';
  const ts = await highlight(tsx, 'tsx');
  if (!ts) throw new Error('not highlighted');
  expect(runs(ts, tsx, 0)[0]).toEqual(['import', 'text-syntax-keyword']);
  expect(runs(ts, tsx, 1)).toContainEqual(['\\.', 'text-syntax-string-regexp font-semibold']);
  expect(runs(ts, tsx, 2)).toContainEqual(['div', 'text-syntax-entity-tag']);

  const md = '# Title\n\n*it* **bold** [link](https://example.com)\n- item';
  const m = await highlight(md, 'markdown');
  if (!m) throw new Error('not highlighted');
  expect(runs(m, md, 0)).toEqual([['# Title', 'text-syntax-markup-heading font-semibold']]);
  expect(runs(m, md, 2)).toEqual([
    ['*it*', 'text-syntax-markup-italic italic'], [' ', ''], ['**bold**', 'text-syntax-markup-bold font-semibold'], [' [', ''],
    ['link', 'text-syntax-constant-other-reference-link underline'], ['](', ''], ['https://example.com', 'underline'], [')', ''],
  ]);
  expect(runs(m, md, 3)[0]).toEqual(['-', 'text-syntax-markup-list']);

  const patch = '@@ -1 +1 @@\n-old\n+new';
  const d = await highlight(patch, 'diff');
  if (!d) throw new Error('not highlighted');
  expect(runs(d, patch, 0)[0]?.[1]).toBe('text-syntax-meta-diff-range font-semibold');
  expect(runs(d, patch, 1)).toEqual([['-old', 'text-syntax-markup-deleted bg-syntax-markup-deleted']]);
  expect(runs(d, patch, 2)).toEqual([['+new', 'text-syntax-markup-inserted bg-syntax-markup-inserted']]);
});

test('pack merges neighbours of a class and fills what Shiki skipped', () => {
  const kw = 'var(--color-prettylights-syntax-keyword)';
  const spans: number[] = [];
  pack(spans, [{content: 'ab', color: kw}, {content: 'c', color: kw}], 4);
  pack(spans, [], 3);
  expect(spans).toEqual([3, style('keyword'), 1, 0, 3, 0]);
});
