// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

// The bundled fonts (fonts.css, #275): every family the font stacks name (tokens.css) is served with the app, upright
// and italic, at Primer's weights, for the scripts its subsets claim; and nothing in the app sets a font family of its
// own (only the tokens do).

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(join(here, 'fonts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {dependencies: Record<string, string>};

interface Face {family: string; style: string; weight: [number, number]; display: string; src: string; ranges: [number, number][]}

const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1] ?? '';
  const get = (d: string) => new RegExp(`(?:^|;)\\s*${d}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? '';
  const [lo = 0, hi = lo] = get('font-weight').split(/\s+/).map(Number);
  return {
    family: get('font-family').replace(/^"|"$/g, ''),
    style: get('font-style'),
    weight: [lo, hi],
    display: get('font-display'),
    src: /url\("([^"]+)"\)/.exec(get('src'))?.[1] ?? '',
    ranges: get('unicode-range').split(',').map((r) => {
      const [a = '0', b = a] = r.trim().replace(/^U\+/i, '').split('-');
      return [Number.parseInt(a, 16), Number.parseInt(b, 16)];
    }),
  };
});

/** The faces of a family that render a character upright or italic. */
const covering = (family: string, style: string, char: string) => {
  const cp = char.codePointAt(0) ?? 0;
  return faces.filter((f) => f.family === family && f.style === style && f.ranges.some(([a, b]) => cp >= a && cp <= b));
};

describe('fonts.css', () => {
  test('every face is a bundled woff2 file of a pinned dependency, swapped in, variable over Primer\'s weights', () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      const file = join(here, f.src);
      expect(existsSync(file) && statSync(file).size > 0, f.src).toBe(true);
      expect(f.src, f.src).toMatch(/\.woff2$/);
      const dep = /node_modules\/(@fontsource-variable\/[\w-]+)\//.exec(f.src)?.[1] ?? '';
      expect(pkg.dependencies[dep], `${dep} in package.json`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(f.display, f.src).toBe('swap');
      expect(f.weight[0], f.src).toBeLessThanOrEqual(400);
      expect(f.weight[1], f.src).toBeGreaterThanOrEqual(600);
    }
  });

  test.each(['normal', 'italic'])('the UI, its other scripts and code are covered, %s', (style) => {
    // Latin (and Latin Extended, Vietnamese): Mona Sans.
    for (const c of ['A', 'z', '0', '`', '–', '€', 'ą', 'ő', 'ơ', 'ự']) expect(covering('Mona Sans VF', style, c), c).not.toEqual([]);
    // Scripts Mona Sans has no glyphs for: Noto Sans, after it in the stack.
    for (const c of ['Ж', 'ё', 'Ω', 'ἀ', 'क']) {
      expect(covering('Mona Sans VF', style, c), c).toEqual([]);
      expect(covering('Noto Sans VF', style, c), c).not.toEqual([]);
    }
    // Code: Source Code Pro.
    for (const c of ['A', '{', '0', '`', 'ą', 'Ж', 'Ω', 'ự']) expect(covering('Source Code Pro VF', style, c), c).not.toEqual([]);
  });

  test('the font stacks name only bundled families before their generic fallback', () => {
    const tokens = readFileSync(join(here, 'tokens.css'), 'utf8');
    const declared = new Set(faces.map((f) => f.family));
    for (const m of tokens.matchAll(/--fontStack-[\w-]+:\s*([^;]+);/g)) {
      const named = (m[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('"')).map((s) => s.slice(1, -1));
      const bundled = named.filter((f) => !f.endsWith('Emoji'));
      for (const f of bundled) expect(declared, f).toContain(f);
    }
  });
});

describe('no page-local font families', () => {
  // Only tokens: Tailwind's font-sans / font-mono, var(--font-*) or var(--fontStack-*), or inherit.
  const allowed = /^(?:inherit|var\(--(?:font|fontStack)-[\w-]+\))$/;
  const sources = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'dev' ? [] : sources(p);
    return /\.(?:css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'fonts.css' ? [p] : [];
  });

  test('no source file sets a font family of its own', () => {
    const offenders: string[] = [];
    for (const file of sources(join(here, '..'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/font-family:\s*([^;}]+)[;}]|fontFamily:\s*'([^']+)'/g)) {
        const value = (m[1] ?? m[2] ?? '').trim();
        if (!allowed.test(value)) offenders.push(`${file.slice(here.length - 'styles/'.length)}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
