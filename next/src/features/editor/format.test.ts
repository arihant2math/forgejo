// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {type Edit, formatEdit} from './format.ts';

const apply = (doc: string, e: Edit) => `${doc.slice(0, e.from)}${e.insert}${doc.slice(e.to)}`;

test('bold and italic wrap the selection, and unwrap it again', () => {
  const doc = 'draft text bold';
  const e = formatEdit(doc, 11, 15, 'bold');
  const bolded = apply(doc, e);
  expect(bolded).toBe('draft text **bold**');
  expect(bolded.slice(e.anchor, e.head)).toBe('bold');
  expect(apply(bolded, formatEdit(bolded, e.anchor, e.head, 'bold'))).toBe(doc);
  expect(apply(doc, formatEdit(doc, 0, 5, 'italic'))).toBe('_draft_ text bold');
  // Nothing selected: the marks with the caret between them.
  const empty = formatEdit('ab', 1, 1, 'bold');
  expect(apply('ab', empty)).toBe('a****b');
  expect([empty.anchor, empty.head]).toEqual([3, 3]);
});

test('a link wraps the selection and selects the URL to type over', () => {
  const doc = 'see docs here';
  const e = formatEdit(doc, 4, 8, 'link');
  const out = apply(doc, e);
  expect(out).toBe('see [docs](url) here');
  expect(out.slice(e.anchor, e.head)).toBe('url');
  const bare = formatEdit('', 0, 0, 'link');
  expect(apply('', bare).slice(bare.anchor, bare.head)).toBe('text');
});
