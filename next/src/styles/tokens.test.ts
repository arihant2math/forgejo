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
    const backgrounds = ['canvas', 'surface', 'raised', 'hover', 'selected', 'raised-hover', 'canvas-hover', 'canvas-selected'];
    const failures: string[] = [];
    const need = (fg: string, bg: string, min: number) => {
      const r = contrast(color(`--color-${fg}`), color(`--color-${bg}`));
      if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const fg of text) for (const bg of backgrounds) need(fg, bg, 4.5);
    for (const [fg, bg] of [['accent-fg', 'accent-subtle'], ['success', 'success-subtle'], ['warning', 'warning-subtle'], ['danger', 'danger-subtle'], ['done', 'done-subtle'], ['fg-muted', 'hover']]) need(fg ?? '', bg ?? '', 4.5);
    for (const bg of ['accent', 'accent-hover', 'danger-solid', 'danger-solid-hover']) need('fg-on-accent', bg, 4.5);
    for (const bg of ['canvas', 'surface', 'raised']) need('focus', bg, 3);
    // Fills must read as a change of state on the surface they sit on (not a WCAG
    // pair: Linear-like subtle fills, but never invisible).
    need('raised-hover', 'raised', 1.15);
    need('hover', 'surface', 1.1);
    need('canvas-hover', 'canvas', 1.1);
    need('canvas-selected', 'canvas', 1.15);
    need('selected', 'surface', 1.15);
    need('border-strong', 'selected', 1.15); // chip and avatar edges on a selected row
    // Code (F7): every syntax colour and the text on every line background of a code view.
    for (const fg of ['fg', 'fg-muted', 'syn-keyword', 'syn-string', 'syn-comment', 'syn-function', 'syn-constant', 'syn-parameter', 'accent-fg']) {
      for (const bg of ['surface', 'hover', 'diff-add', 'diff-del']) need(fg, bg, 4.5);
    }
    for (const bg of ['diff-add-strong', 'diff-del-strong', 'accent-subtle']) need('fg-subtle', bg, 4.5); // line numbers on the gutters, hunk headers
    need('diff-add-strong', 'diff-add', 1.1);
    need('diff-del-strong', 'diff-del', 1.1);
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

describe('label ink (text-label)', () => {
  // CSS color-mix(in oklab, label X%, fg): the icon colour of a status or priority label.
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const hex = (h: string) => [0, 2, 4].map((i) => Number.parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255);
  function oklab([r, g, b]: number[]): number[] {
    const [lr, lg, lb] = [r ?? 0, g ?? 0, b ?? 0].map(toLinear) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function rgb([L, A, B]: number[]): string {
    const l = ((L ?? 0) + 0.3963377774 * (A ?? 0) + 0.2158037573 * (B ?? 0)) ** 3;
    const m = ((L ?? 0) - 0.1055613458 * (A ?? 0) - 0.0638541728 * (B ?? 0)) ** 3;
    const s = ((L ?? 0) - 0.0894841775 * (A ?? 0) - 1.291485548 * (B ?? 0)) ** 3;
    const c = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return `#${c.map((x) => Math.round(Math.min(1, Math.max(0, toSrgb(x))) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  const light = decls(block('@theme static'));
  const dark = decls(block(':root[data-theme="dark"]'));
  const share = Number.parseFloat(decls(block(':root')).get('--label-ink') ?? 'NaN') / 100;
  const mix = (label: string, fg: string) => {
    const a = oklab(hex(label));
    const b = oklab(hex(fg));
    return rgb(a.map((x, i) => x * share + (b[i] ?? 0) * (1 - share)));
  };
  // Light and saturated label colours of Forgejo's presets and common palettes.
  const labels = ['#eab308', '#facc15', '#22c55e', '#06b6d4', '#f97316', '#ffffff', '#e11d48', '#3b82f6', '#8b5cf6', '#fbca04', '#c2e0c6', '#bfdadc'];
  test.each(['light', 'dark'] as const)('≥ 3:1 against the surfaces (%s)', (theme) => {
    const t = theme === 'light' ? light : dark;
    const fg = t.get('--color-fg') ?? '';
    for (const bg of ['--color-surface', '--color-hover', '--color-canvas']) {
      for (const l of labels) expect(contrast(mix(l, fg), t.get(bg) ?? light.get(bg) ?? ''), `${l} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
