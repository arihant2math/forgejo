// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {paintTokens} from '../../code/parts.tsx';

test('markdown highlighting uses text nodes, preserves lines and ignores unknown token classes', () => {
  const el = document.createElement('code');
  el.textContent = '<script>\nrest';
  paintTokens(el, {starts: new Uint32Array([0, 1, 2]), spans: new Uint32Array([8, 1, 4, 999])});
  expect(el.textContent).toBe('<script>\nrest');
  expect(el.querySelector('script')).toBeNull();
  expect(el.querySelector('span')?.className).toBe('text-syntax-keyword');
  expect(el.querySelectorAll('span')).toHaveLength(1);
});

test('a block without highlight offsets keeps every line verbatim', () => {
  const el = document.createElement('code');
  el.textContent = 'one\ntwo\n';
  paintTokens(el, {starts: new Uint32Array(), spans: new Uint32Array()});
  expect(el.textContent).toBe('one\ntwo\n');
});
