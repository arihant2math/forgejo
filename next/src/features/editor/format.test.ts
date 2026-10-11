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

test('code: inline for a selection within a line, unwrapped again, with longer ticks around backticks', () => {
  const doc = 'run npm test now';
  const e = formatEdit(doc, 4, 12, 'code');
  const out = apply(doc, e);
  expect(out).toBe('run `npm test` now');
  expect(out.slice(e.anchor, e.head)).toBe('npm test');
  expect(apply(out, formatEdit(out, e.anchor, e.head, 'code'))).toBe(doc);
  expect(apply('a `b` c', formatEdit('a `b` c', 0, 7, 'code'))).toBe('``a `b` c``');
  expect(apply('`x', formatEdit('`x', 0, 2, 'code'))).toBe('`` `x ``');
});

test('code: a fenced block for several lines or an empty caret, on lines of its own', () => {
  const log = 'Error: boom\n  at main.go:12';
  const doc = `Crash:\n${log}\nThanks`;
  const from = doc.indexOf('Error');
  const e = formatEdit(doc, from, from + log.length, 'code');
  const out = apply(doc, e);
  expect(out).toBe(`Crash:\n\`\`\`\n${log}\n\`\`\`\nThanks`);
  expect(out.slice(e.anchor, e.head)).toBe(log);
  // Applied again to the same text: the fence goes.
  expect(apply(out, formatEdit(out, e.anchor, e.head, 'code'))).toBe(doc);
  // Nothing selected, mid-line: the block starts on a new line, the caret inside it.
  const empty = formatEdit('See:', 4, 4, 'code');
  const block = apply('See:', empty);
  expect(block).toBe('See:\n```\n\n```');
  expect(empty.anchor).toBe(block.indexOf('```\n') + 4);
  // An empty document: just the fence.
  expect(apply('', formatEdit('', 0, 0, 'code'))).toBe('```\n\n```');
  // Code with a fence inside takes a longer one.
  const nested = 'a\n```\nb';
  expect(apply(nested, formatEdit(nested, 0, nested.length, 'code'))).toBe('````\na\n```\nb\n````');
});
