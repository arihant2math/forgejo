// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';
import {contrastRatio, DARK_INK, LIGHT_INK, labelInk, luminance, parseHex} from './ink.ts';

test('hex colours parse; anything else does not', () => {
  expect(parseHex('#fff')).toEqual([255, 255, 255]);
  expect(parseHex('#E11D21')).toEqual([225, 29, 33]);
  expect(parseHex('#00000080')).toEqual([0, 0, 0]);
  for (const c of ['fff', '#ffff', 'red', 'var(--color-danger)', '#gggggg', '']) expect(parseHex(c), c).toBeUndefined();
});

test('the ink with the higher contrast wins', () => {
  // Forgejo's preset colours: dark fills take light text, pale ones dark text.
  for (const c of ['#e11d21', '#006b75', '#0052cc', '#5319e7', '#000']) expect(labelInk(c), c).toBe('light');
  for (const c of ['#fbca04', '#009800', '#f6c6c7', '#fef2c0', '#bfe5bf', '#c7def8', '#d4c5f9', '#fff', '#70c24a']) expect(labelInk(c), c).toBe('dark');
  expect(labelInk('nonsense')).toBeUndefined();
});

test('the chosen ink always has at least 4:1 on the fill, whatever the colour', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        const l = luminance([r, g, b]);
        const ink = labelInk(hex) === 'light' ? LIGHT_INK : DARK_INK;
        expect(contrastRatio(l, ink), hex).toBeGreaterThanOrEqual(4);
      }
    }
  }
});

test('the inks are the tokens\' colours', () => {
  const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
  const value = (name: string) => new RegExp(`${name}:\\s*(#[\\da-f]+);`, 'i').exec(css)?.[1] ?? '';
  expect(luminance(parseHex(value('--color-on-label-dark')) ?? [255, 255, 255])).toBeCloseTo(DARK_INK, 3);
  expect(luminance(parseHex(value('--color-on-label-light')) ?? [0, 0, 0])).toBeCloseTo(LIGHT_INK, 3);
});
