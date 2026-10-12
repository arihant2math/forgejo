// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

// Resolve aliases through Primer themes so missing variables fail here, not on screen.

import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, expect, test} from 'vitest';

const css = readFileSync(new URL('tokens.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const primer = (path: string) => readFileSync(require.resolve(`@primer/primitives/dist/css/${path}`), 'utf8');

function block(selector: string, text = css): string {
  const start = text.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i);
  }
  throw new Error(`unterminated ${selector}`);
}

const decls = (text: string) => new Map([...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2]?.trim() ?? '']));

const sizes = ['base/size/size.css', 'base/typography/typography.css', 'base/motion/motion.css', 'functional/size/border.css',
  'functional/size/radius.css', 'functional/size/size.css', 'functional/size/size-fine.css', 'functional/size/z-index.css',
  'functional/spacing/space.css', 'functional/typography/typography.css', 'functional/motion/motion.css'];
const shared = new Map(sizes.flatMap((f) => [...decls(primer(f))]));
const themes = {
  light: new Map([...shared, ...decls(block('[data-color-mode="light"][data-light-theme="light"],\n[data-color-mode="auto"][data-light-theme="light"]', primer('functional/themes/light.css')))]),
  dark: new Map([...shared, ...decls(block('[data-color-mode="dark"][data-dark-theme="dark"],\n[data-color-mode="auto"][data-light-theme="dark"]', primer('functional/themes/dark.css')))]),
};
type Theme = keyof typeof themes;

const tokens = decls(block('@theme static'));
const root = decls(block(':root'));

function resolve(value: string, theme: Theme, seen: string[] = []): string {
  return value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => {
    if (seen.includes(name)) throw new Error(`var cycle ${[...seen, name].join(' → ')}`);
    const v = tokens.get(name) ?? root.get(name) ?? themes[theme].get(name) ?? fallback;
    if (v === undefined) throw new Error(`${seen[0] ?? value}: ${name} is not defined in Primer's ${theme} theme`);
    return resolve(v, theme, [...seen, name]);
  });
}

function rgba(hex: string): [number, number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length <= 4 ? h.replace(/./g, '$&$&') : h;
  const [r = 0, g = 0, b = 0, a = 255] = [0, 2, 4, 6].map((i) => (i < full.length ? Number.parseInt(full.slice(i, i + 2), 16) : 255));
  return [r / 255, g / 255, b / 255, a / 255];
}

function over(top: string, bottom: string): string {
  const [r, g, b, a] = rgba(top);
  const [r2, g2, b2] = rgba(bottom);
  return `#${[[r, r2], [g, g2], [b, b2]].map(([x = 0, y = 0]) => Math.round((x * a + y * (1 - a)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 contrast ratio of two opaque #rgb / #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = rgba(hex).slice(0, 3).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('tokens.css', () => {
  test('Primer uses a 16px rem root while the UI body stays 14px', () => {
    const base = readFileSync(new URL('base.css', import.meta.url), 'utf8');
    expect(block('html', base)).toContain('font-size: var(--base-size-16)');
    expect(block('body', base)).toContain('font-size: var(--text-base)');
    expect(resolve('var(--base-size-16)', 'light')).toBe('1rem');
    expect(resolve('var(--text-base)', 'light')).toBe('0.875rem');
  });
  test.each(['light', 'dark'] as const)('every token resolves in Primer\'s %s theme', (theme) => {
    for (const [name, value] of [...tokens, ...root]) expect(() => resolve(value, theme), name).not.toThrow();
  });

  test.each(['light', 'dark'] as const)('WCAG contrast, %s theme', (theme) => {
    const surface = resolve('var(--background-color-default)', theme);
    const color = (token: string, base = surface) => over(resolve(`var(${token})`, theme), base);
    const failures: string[] = [];
    const need = (fg: string, bg: string, min: number) => {
      const b = color(`--background-color-${bg}`);
      const r = contrast(color(`--text-color-${fg}`, b), b);
      if (r < min) failures.push(`text-${fg} on bg-${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const fg of ['default', 'muted', 'accent', 'success', 'attention', 'danger', 'done']) for (const bg of ['inset', 'default', 'overlay']) need(fg, bg, 4.5);
    for (const fg of ['default', 'muted']) for (const bg of ['control-transparent-hover', 'control-transparent-selected']) need(fg, bg, 4.5);
    for (const bg of ['accent-emphasis', 'success-emphasis', 'danger-emphasis']) need('onEmphasis', bg, 4.5);
    for (const fg of ['default', 'syntax-keyword', 'syntax-string', 'syntax-entity', 'syntax-constant']) {
      for (const bg of ['default', 'diff-addition-line', 'diff-deletion-line']) need(fg, bg, 4.5);
    }
    expect(failures).toEqual([]);
  });

  test('motion tokens', () => {
    expect(root.get('--speed-in')).toBe('0s');
    expect(root.get('--speed-out')).toBe('0.15s');
  });

  test('prefers-reduced-motion drops exit animations', () => {
    const reduced = decls(block('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.get('--speed-out')).toBe('0s');
  });

  test('Primer\'s body size and system font stack are the UI\'s', () => {
    expect(resolve('var(--text-base)', 'light')).toBe('0.875rem');
    expect(tokens.get('--font-sans')).toBe('var(--fontStack-system)');
  });
});
