// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const css = readFileSync(new URL('tokens.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`unterminated ${selector}`);
}

/** WCAG 2 contrast ratio of two #rgb / #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6);
    const [r = 0, g = 0, bl = 0] = [0, 2, 4].map((i) => {
      const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const decls = (text: string) => new Map([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim()]));

describe('tokens.css', () => {
  const light = decls(block('@theme static'));
  const dark = decls(block(':root[data-theme="dark"]'));
  const root = decls(block(':root'));

  test.each(['light', 'dark'] as const)('WCAG contrast, %s theme', (theme) => {
    const color = (name: string) => {
      const v = (theme === 'dark' ? dark.get(name) : undefined) ?? light.get(name);
      if (!v) throw new Error(`no ${name}`);
      return v;
    };
    const text = ['fg', 'fg-muted', 'fg-subtle', 'accent-fg', 'success', 'warning', 'danger', 'done'];
    const backgrounds = ['canvas', 'surface', 'raised', 'hover', 'selected'];
    const failures: string[] = [];
    const need = (fg: string, bg: string, min: number) => {
      const r = contrast(color(`--color-${fg}`), color(`--color-${bg}`));
      if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const fg of text) for (const bg of backgrounds) need(fg, bg, 4.5);
    for (const [fg, bg] of [['accent-fg', 'accent-subtle'], ['success', 'success-subtle'], ['warning', 'warning-subtle'], ['danger', 'danger-subtle'], ['done', 'done-subtle'], ['fg-muted', 'hover']]) need(fg ?? '', bg ?? '', 4.5);
    for (const bg of ['accent', 'accent-hover', 'danger-solid', 'danger-solid-hover']) need('fg-on-accent', bg, 4.5);
    for (const bg of ['canvas', 'surface', 'raised']) need('focus', bg, 3);
    expect(failures).toEqual([]);
  });

  test('the dark theme overrides exactly the colour tokens', () => {
    const colors = [...light.keys()].filter((k) => k?.startsWith('--color-')).sort();
    expect(colors.length).toBeGreaterThan(20);
    expect([...dark.keys()].sort()).toEqual(colors);
  });

  test('motion tokens (PLAN §5.6)', () => {
    expect(root.get('--speed-in')).toBe('0s');
    expect(root.get('--speed-out')).toBe('0.15s');
    expect(root.get('--speed-quick')).toBe('0.1s');
  });

  test('prefers-reduced-motion drops exit animations', () => {
    const reduced = decls(block('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.get('--speed-out')).toBe('0s');
    expect(reduced.get('--animate-exit')).toBe('none');
    expect(reduced.get('--animate-exit-pop')).toBe('none');
  });

  test('UI base size is 13px with the system font stack', () => {
    expect(light.get('--text-base')).toBe('13px');
    expect(light.get('--font-sans')).toMatch(/^-apple-system, blinkmacsystemfont, .*system-ui/);
  });
});
