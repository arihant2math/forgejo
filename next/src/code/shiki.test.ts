// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {__unstable__loadDesignSystem} from '@tailwindcss/node';
import {expect, test} from 'vitest';
import {ALIASES, classCode, GRAMMARS, LANGS, langOf, langOfName, synClass, SYNTAX, THEME} from './shiki.ts';

test('every grammar is a Shiki language, and the aliases are exactly Shiki\'s own', {timeout: 60_000}, async () => {
  for (const lang of LANGS) {
    const regs = (await GRAMMARS[lang]()).default;
    const own = regs.find((r) => r.name === lang);
    expect(own, lang).toBeDefined();
    const ours = Object.entries(ALIASES).filter(([, l]) => l === lang).map(([a]) => a).sort();
    expect(ours, lang).toEqual([...own?.aliases ?? []].sort());
  }
});

test('fences name languages by Shiki id or alias, file extension or linguist name, in any case', () => {
  expect(langOfName('typescript')).toBe('typescript');
  expect(langOfName('TS')).toBe('typescript');
  expect(langOfName('python')).toBe('python');
  expect(langOfName('py')).toBe('python');
  expect(langOfName('rust')).toBe('rust');
  expect(langOfName('shell')).toBe('shellscript');
  expect(langOfName('console')).toBe('shellsession');
  expect(langOfName('c++')).toBe('cpp');
  expect(langOfName('C#')).toBe('csharp');
  expect(langOfName('dockerfile')).toBe('docker');
  expect(langOfName('golang')).toBe('go');
  expect(langOfName('tex')).toBe('latex');
  expect(langOfName('json5')).toBe('jsonc');
  expect(langOfName('tf')).toBe('hcl');
  expect(langOfName('Patch')).toBe('diff');
  // Shiki's alias wins over the extension table, which keeps .ps files (PostScript) plain.
  expect(langOfName('ps')).toBe('powershell');
  expect(langOfName('suggestion')).toBeUndefined();
  expect(langOfName('text')).toBeUndefined();
});

test('languages by file name', () => {
  expect(langOf('src/a.tsx')).toBe('tsx');
  expect(langOf('src/a.mjs')).toBe('javascript');
  expect(langOf('lib/x.rs')).toBe('rust');
  expect(langOf('include/x.h')).toBe('c');
  expect(langOf('Dockerfile')).toBe('docker');
  expect(langOf('x/Makefile')).toBe('make');
  expect(langOf('a.properties')).toBe('ini');
  expect(langOf('README')).toBeUndefined();
  expect(langOf('a.unknownext')).toBeUndefined();
  expect(langOf('figure.ps')).toBeUndefined();
  expect(langOf('.github/workflows/ci.YML')).toBe('yaml');
});

test('the theme uses only Primer\'s prettylights variables, each of which maps back to a style', () => {
  const vars = new Set<string>();
  for (const s of THEME.settings ?? []) {
    for (const v of [s.settings.foreground, s.settings.background]) if (v) vars.add(v);
  }
  for (const v of vars) expect(v).toMatch(/^var\(--color-prettylights-syntax-[a-z-]+\)$/);
  for (const v of vars) if (!v.endsWith('-bg)')) expect(classCode(v, 0), v).toBeGreaterThan(0);
  expect(classCode('var(--fgColor-default)', 0)).toBe(0);
  expect(synClass(classCode(undefined, 0))).toBe('');
});

test('every class a code can produce exists in the theme', async () => {
  const styles = fileURLToPath(new URL('../styles/', import.meta.url));
  const ds = await __unstable__loadDesignSystem(readFileSync(`${styles}app.css`, 'utf8'), {base: styles});
  const classes = new Set<string>();
  for (let style = 0; style < SYNTAX.length; style++) {
    for (let font = 0; font < 16; font++) for (const c of synClass(style | (font << 5)).split(' ').filter(Boolean)) classes.add(c);
  }
  const list = [...classes];
  const css = ds.candidatesToCss(list);
  expect(list.filter((_, i) => css[i] === null)).toEqual([]);
  expect(synClass(2 | (12 << 5))).toBe('text-syntax-string line-through');
});
