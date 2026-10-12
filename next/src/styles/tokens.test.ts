// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

// The app's tokens are aliases of Primer's (@primer/primitives): these checks resolve them through Primer's light
// and dark themes and size/typography files, so a renamed or missing Primer variable fails here, not on screen.

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

// Primer's non-colour tokens (the same in both themes) and each theme's colours (its first, unconditional block).
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

/** A token's value with every var() resolved in a theme (throws on a variable neither defines). */
function resolve(value: string, theme: Theme, seen: string[] = []): string {
  return value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => {
    if (seen.includes(name)) throw new Error(`var cycle ${[...seen, name].join(' → ')}`);
    const v = tokens.get(name) ?? root.get(name) ?? themes[theme].get(name) ?? fallback;
    if (v === undefined) throw new Error(`${seen[0] ?? value}: ${name} is not defined in Primer's ${theme} theme`);
    return resolve(v, theme, [...seen, name]);
  });
}

/** The red, green, blue (0–1) and alpha of a #rgb / #rrggbb / #rrggbbaa colour. */
function rgba(hex: string): [number, number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length <= 4 ? h.replace(/./g, '$&$&') : h;
  const [r = 0, g = 0, b = 0, a = 255] = [0, 2, 4, 6].map((i) => (i < full.length ? Number.parseInt(full.slice(i, i + 2), 16) : 255));
  return [r / 255, g / 255, b / 255, a / 255];
}

/** A colour with alpha painted over an opaque one, as #rrggbb. */
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
    // A token as an opaque colour: fills with alpha (Primer's transparent controls) over the surface.
    const color = (token: string, base = surface) => over(resolve(`var(${token})`, theme), base);
    const failures: string[] = [];
    const need = (fg: string, bg: string, min: number) => {
      const b = color(`--background-color-${bg}`);
      const r = contrast(color(`--text-color-${fg}`, b), b);
      if (r < min) failures.push(`text-${fg} on bg-${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const fg of ['default', 'muted', 'accent', 'success', 'attention', 'danger', 'done']) for (const bg of ['inset', 'default', 'overlay']) need(fg, bg, 4.5);
    // On a hovered or selected row: the text colours (Primer's status colours are made for the plain surfaces).
    for (const fg of ['default', 'muted']) for (const bg of ['control-transparent-hover', 'control-transparent-selected']) need(fg, bg, 4.5);
    for (const bg of ['accent-emphasis', 'success-emphasis', 'danger-emphasis']) need('onEmphasis', bg, 4.5);
    for (const fg of ['default', 'syntax-keyword', 'syntax-string', 'syntax-entity', 'syntax-constant']) {
      for (const bg of ['default', 'diff-addition-line', 'diff-deletion-line']) need(fg, bg, 4.5);
    }
    expect(failures).toEqual([]);
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

  test('Primer\'s body size and font stacks are the UI\'s', () => {
    expect(resolve('var(--text-base)', 'light')).toBe('0.875rem');
    expect(tokens.get('--font-sans')).toBe('var(--fontStack-sansSerif)');
    expect(tokens.get('--font-mono')).toBe('var(--fontStack-monospace)');
  });

  // #275: Primer's stacks put the system UI font (-apple-system, Segoe UI, …) and the system code font (ui-monospace,
  // SFMono, Menlo, Consolas, …) in the ordinary rendering path. Every Primer stack and Tailwind alias is pinned to the
  // bundled families (fonts.css); only generic families and emoji fonts may follow them, as the emergency fallback.
  test.each(['light', 'dark'] as const)('font stacks are the bundled fonts, %s theme', (theme) => {
    const families = (token: string) => resolve(`var(${token})`, theme).split(',').map((f) => f.trim().replace(/^"|"$/g, ''));
    const fallback = new Set(['sans-serif', 'monospace', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji']);
    const sans = ['Mona Sans VF', 'Noto Sans VF'];
    for (const token of ['--font-sans', '--default-font-family', '--fontStack-sansSerif', '--fontStack-sansSerifDisplay', '--fontStack-system']) {
      const stack = families(token);
      expect(stack.slice(0, 2), token).toEqual(sans);
      expect(stack.slice(2).filter((f) => !fallback.has(f)), token).toEqual([]);
    }
    for (const token of ['--font-mono', '--default-mono-font-family', '--fontStack-monospace']) {
      expect(families(token), token).toEqual(['Source Code Pro VF', 'monospace']);
    }
    // The shorthands Primer's components use (text-body-shorthand-*, text-codeBlock-shorthand, …) go through them too.
    expect(resolve('var(--text-body-shorthand-medium)', theme)).toContain('"Mona Sans VF", "Noto Sans VF"');
    expect(resolve('var(--text-title-shorthand-medium)', theme)).toContain('"Mona Sans VF", "Noto Sans VF"');
    expect(resolve('var(--text-codeBlock-shorthand)', theme)).toContain('"Source Code Pro VF"');
    const named = [...families('--fontStack-system'), ...families('--fontStack-monospace')];
    for (const system of ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas']) {
      expect(named).not.toContain(system);
    }
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
  // The tokens' colours in a theme, as opaque #rrggbb (over the surface).
  const resolved = (theme: Theme) => {
    const surface = resolve('var(--bgColor-default)', theme);
    return {get: (name: string) => over(resolve(`var(${name})`, theme), surface)};
  };
  const light = resolved('light');
  const dark = resolved('dark');
  const share = Number.parseFloat(decls(block(':root')).get('--label-ink') ?? 'NaN') / 100;
  const mix = (label: string, fg: string, part = share) => {
    const a = oklab(hex(label));
    const b = oklab(hex(fg));
    return rgb(a.map((x, i) => x * part + (b[i] ?? 0) * (1 - part)));
  };
  // Light and saturated label colours of Forgejo's presets and common palettes.
  const labels = ['#eab308', '#facc15', '#22c55e', '#06b6d4', '#f97316', '#ffffff', '#e11d48', '#3b82f6', '#8b5cf6', '#fbca04', '#c2e0c6', '#bfdadc'];
  test.each(['light', 'dark'] as const)('≥ 3:1 against the surfaces (%s)', (theme) => {
    const t = theme === 'light' ? light : dark;
    const fg = t.get('--text-color-default');
    for (const bg of ['--background-color-default', '--background-color-control-transparent-hover', '--background-color-inset']) {
      for (const l of labels) expect(contrast(mix(l, fg), t.get(bg)), `${l} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  // A filled label (LabelPill, LabelDot) is edged by its colour mixed towards the text colour (edge-label): whatever
  // the colour (white on the light canvas, black on the dark), its fill or its edge stands out from the surface.
  const edge = Number.parseFloat(decls(block(':root')).get('--label-edge') ?? 'NaN') / 100;
  test.each(['light', 'dark'] as const)('a label\'s fill or edge is ≥ 1.5:1 against the surfaces (%s)', (theme) => {
    const t = theme === 'light' ? light : dark;
    const fg = t.get('--text-color-default');
    const failures: string[] = [];
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const fill = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
          for (const bg of ['--background-color-inset', '--background-color-default', '--background-color-overlay', '--background-color-control-transparent-hover', '--background-color-control-transparent-selected']) {
            const surface = t.get(bg);
            const best = Math.max(contrast(fill, surface), contrast(mix(fill, fg, edge), surface));
            if (best < 1.5) failures.push(`${fill} on ${bg}: ${best.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
