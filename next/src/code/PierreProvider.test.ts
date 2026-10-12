// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {getSharedHighlighter, RegisteredCustomLanguages, renderFileWithHighlighter, resolveLanguage, resolveTheme} from '@pierre/diffs';
import {createHighlighterCore} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
import {expect, test, vi} from 'vitest';
import {primed} from '../test/pierreWorker.ts';
import {fileContents, primeFile, renderOptions} from './PierreProvider.tsx';
import {pierreFile} from './pierrePatch.ts';
import {GRAMMARS, LANGS, LIMITS, THEME} from './shiki.ts';

vi.mock('@pierre/diffs/worker', () => import('../test/pierreWorker.ts'));

const NAME = THEME.name ?? '';
const SOURCE = 'package main // x\n';
const KEYWORD = 'color:var(--color-prettylights-syntax-keyword)';

test('Pierre highlights with the code worker\'s prettylights theme, on the main thread and in its workers', async () => {
  expect(renderOptions.theme).toBe(NAME);
  const theme = await resolveTheme(NAME);
  expect(theme.name).toBe(NAME);
  const main = await getSharedHighlighter({themes: [NAME], langs: ['go'], preferredHighlighter: 'shiki-js'});
  const {code, themeStyles} = renderFileWithHighlighter(fileContents('s', 'a.go', SOURCE), main, {theme: NAME, tokenizeMaxLineLength: LIMITS.lineLength, useTokenTransformer: false});
  expect(JSON.stringify(code[0])).toContain(`"style":"${KEYWORD}"`);
  expect(themeStyles).toContain('--diffs-fg:var(--fgColor-default)');
  // A pool worker receives the resolved theme and grammar as structured clones.
  const worker = await createHighlighterCore({
    themes: [structuredClone(theme)], langs: [structuredClone((await resolveLanguage('go')).data)], engine: createJavaScriptRegexEngine({forgiving: true}),
  });
  expect(worker.codeToHtml(SOURCE, {lang: 'go', theme: NAME})).toContain(`style="${KEYWORD}"`);
});

test('Pierre loads only the curated grammars, through shiki.ts\'s loaders and path resolution', () => {
  for (const lang of LANGS) expect(RegisteredCustomLanguages.get(lang)).toBe(GRAMMARS[lang]);
  // Pierre's own table would say zsh and nginx.
  expect(fileContents('s', 'build.sh', 'x').lang).toBe('shellscript');
  expect(fileContents('s', 'app.conf', 'x').lang).toBe('ini');
  expect(fileContents('s', 'notes.unknown', 'x').lang).toBe('text');
  expect(fileContents('s', 'a.go', 'x', true).lang).toBe('text');
  expect(fileContents('s', 'a.go', 'x'.repeat(LIMITS.chars + 1)).lang).toBe('text');
  const diff = {oldPath: 'a.sh', newPath: 'a.sh', status: 'modified' as const, binary: false, additions: 0, deletions: 0, hunks: [], lines: []};
  expect(pierreFile(diff, 'k').lang).toBe('shellscript');
});

test('warm-ups stay within the limits under which the view highlights', () => {
  primed.length = 0;
  primeFile('/', 'a', 'a.go', SOURCE);
  primeFile('/', 'b', 'b.go', '\n'.repeat(LIMITS.lines));
  primeFile('/', 'c', 'c.unknown', SOURCE);
  expect(primed.map((f) => f.cacheKey)).toEqual(['a:a.go']);
});
