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

const decls = (text: string) => new Map([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim()]));

describe('tokens.css', () => {
  const light = decls(block('@theme static'));
  const dark = decls(block(':root[data-theme="dark"]'));
  const root = decls(block(':root'));

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
