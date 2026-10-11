// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Text on a colour the server chose (a label's): which of the two inks
// (tokens.css --color-on-label-dark / -light) reads best on it, by WCAG 2
// contrast. Pure, so the pill's text is decided in the render, never measured.

/** The red, green and blue (0–255) of a "#rgb", "#rrggbb" or "#rrggbbaa" colour (the alpha ignored), else undefined. */
export function parseHex(color: string): [number, number, number] | undefined {
  const m = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(color.trim());
  if (!m) return undefined;
  const h = m[1] ?? '';
  const full = h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2 relative luminance (0 black … 1 white). */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two luminances (1 … 21). */
export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The luminances of the two inks (tokens.css: --color-on-label-dark #1b1b1f, --color-on-label-light #fff; ink.test.ts checks). */
export const DARK_INK = 0.0112;
export const LIGHT_INK = 1;

export type Ink = 'dark' | 'light';

/**
 * The ink for text on a fill of `color`: the one with the higher contrast (a tie, or a colour that is not a hex
 * value, reads dark — the caller shows no fill then). Undefined when the colour cannot be read.
 */
export function labelInk(color: string): Ink | undefined {
  const rgb = parseHex(color);
  if (!rgb) return undefined;
  const l = luminance(rgb);
  return contrastRatio(l, LIGHT_INK) > contrastRatio(l, DARK_INK) ? 'light' : 'dark';
}
