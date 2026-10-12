// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';
import {vendorChunk} from '../vite.config.ts';
import type {OutputBundle} from 'rolldown';
import {analyze, BUDGET, chunkCycles, cssProblems} from './budget.ts';
import {fontPreloads, PRELOADED_FONTS} from './vite-plugin-shell.ts';
import {lazyAsset} from './vite-plugin-sw.ts';

describe('vendorChunk', () => {
  test.each([
    ['/x/node_modules/react/index.js', 'vendor-react'],
    ['/x/node_modules/react-dom/cjs/react-dom-client.production.js', 'vendor-react-dom'],
    ['/x/node_modules/@primer/octicons-react/dist/index.esm.mjs', 'vendor-primer-octicons-react'],
    ['/x/node_modules/@primer/react/dist/Button/Button.js', 'vendor-primer-react'],
    ['/x/node_modules/@tanstack/react-router/dist/esm/index.js', 'vendor-tanstack-react-router'],
    ['/x/node_modules/a/node_modules/b/index.js', 'vendor-a'],
    ['/x/src/main.tsx', null],
  ])('%s → %s', (id, name) => {
    expect(vendorChunk(id)).toBe(name);
  });
});

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), {recursive: true});
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const manifest = (imports: string[]) => JSON.stringify({
  'index.html': {file: 'assets/main.js', isEntry: true, imports, dynamicImports: ['src/Home.tsx']},
  _a: {file: 'assets/a.js'},
  'src/Home.tsx': {file: 'assets/home.js', imports: ['_a']},
});

describe('budget', () => {
  test('counts inline script/style, entry and preloads; passes under budget', () => {
    const r = analyze(dist({
      'index.html': '<script>mark()</script><style>a{}</style><script type="module" crossorigin src="/-/next/assets/main.js"></script><link href="/-/next/assets/a.js" crossorigin rel="modulepreload"><link rel=modulepreload href="/-/next/assets/home.js">',
      'assets/main.js': 'x',
      'assets/a.js': 'y',
      'assets/home.js': 'z',
      '.vite/manifest.json': manifest(['_a']),
    }), '/-/next/', ['src/Home.tsx']);
    expect(r.items.map((i) => i.name)).toEqual(['index.html <script> #1', 'index.html <style> #1', 'assets/main.js', 'assets/a.js', 'assets/home.js']);
    expect(r.problems).toEqual([]);
  });

  test('fails when a static import is not preloaded, and when over budget', () => {
    const noise = randomBytes(BUDGET.js * 2).toString('base64'); // incompressible
    const r = analyze(dist({
      'index.html': '<script type="module" src="/-/next/assets/main.js"></script>',
      'assets/main.js': noise,
      'assets/a.js': 'y',
      'assets/home.js': 'z',
      '.vite/manifest.json': manifest(['_a']),
    }), '/-/next/', ['src/Home.tsx', 'src/Missing.tsx']);
    expect(r.problems).toContain('assets/a.js: needed at boot but not preloaded');
    expect(r.problems).toContain('assets/home.js: needed at boot but not preloaded');
    expect(r.problems).toContain('boot route src/Missing.tsx: no chunk of its own in the manifest');
    expect(r.problems.some((p) => p.startsWith('boot JS'))).toBe(true);
  });

  test('flags banned CSS in the output', () => {
    expect(cssProblems(':root{--color-fg:#fff}.a{background-color:#0000}@property --x{initial-value:#fff}')).toEqual([]);
    expect(cssProblems('.bg-\\[\\#fff\\]{background-color:#fff}.t{transition-property:all}')).toHaveLength(2);
    expect(cssProblems('.a{color:rgb(0 0 0)}.b{transition:height .2s}.c{transition-property:color,background-color,border-color,opacity}')).toHaveLength(2);
  });
});

describe('chunkCycles', () => {
  test('finds a static import cycle between chunks', () => {
    expect(chunkCycles({a: {file: 'a.js', imports: ['b']}, b: {file: 'b.js', imports: ['c']}, c: {file: 'c.js'}})).toEqual([]);
    expect(chunkCycles({a: {file: 'a.js', imports: ['b']}, b: {file: 'b.js', imports: ['a']}})).toEqual(['chunk import cycle: a.js → b.js → a.js']);
  });
});

describe('fonts (#275)', () => {
  const bundle = (...files: string[]) => Object.fromEntries(files.map((f) => [f, {type: 'asset', fileName: f}])) as unknown as OutputBundle;

  test('the shell preloads the UI\'s main face, the built file under the base', () => {
    expect(PRELOADED_FONTS).toEqual(['mona-sans-latin-wght-normal']);
    expect(fontPreloads(bundle('assets/mona-sans-latin-ext-wght-normal-B2c.woff2', 'assets/mona-sans-latin-wght-italic-C3d.woff2',
      'assets/mona-sans-latin-wght-normal-A1b_-x.woff2', 'assets/main-D4e.js'), '/-/next/'))
      .toEqual(['<link rel="preload" as="font" type="font/woff2" crossorigin href="/-/next/assets/mona-sans-latin-wght-normal-A1b_-x.woff2">']);
  });

  test('a renamed or missing main face fails the build instead of preloading nothing', () => {
    expect(() => fontPreloads(bundle('assets/mona-sans-latin-ext-wght-normal-B2c.woff2'), '/-/next/')).toThrow(/mona-sans-latin-wght-normal/);
  });

  test('the service worker precaches the Latin faces and caches other scripts\' subsets on first use', () => {
    for (const f of ['assets/mona-sans-latin-wght-normal-A1b.woff2', 'assets/mona-sans-latin-ext-wght-italic-A1b.woff2',
      'assets/source-code-pro-latin-wght-normal-A1b.woff2', 'assets/source-code-pro-latin-ext-wght-italic-A1b.woff2', 'assets/main-A1b.js']) {
      expect(lazyAsset(f), f).toBe(false);
    }
    for (const f of ['assets/noto-sans-cyrillic-wght-normal-A1b.woff2', 'assets/noto-sans-greek-ext-wght-italic-A1b.woff2',
      'assets/noto-sans-devanagari-wght-normal-A1b.woff2', 'assets/mona-sans-vietnamese-wght-italic-A1b.woff2',
      'assets/source-code-pro-cyrillic-ext-wght-normal-A1b.woff2', 'assets/lang-rust-A1b.js']) {
      expect(lazyAsset(f), f).toBe(true);
    }
  });
});
