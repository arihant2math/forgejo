// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {scrub} from '../../app/trusted.ts';
import {appLinks, toggleTask} from './Markdown.tsx';

test('a task is ticked by its index, outside fenced code', () => {
  const text = '- [ ] one\n```\n- [ ] not a task\n```\n1. [x] two\n  * [ ] three';
  expect(toggleTask(text, 0, true)).toBe('- [x] one\n```\n- [ ] not a task\n```\n1. [x] two\n  * [ ] three');
  expect(toggleTask(text, 1, false)).toBe('- [ ] one\n```\n- [ ] not a task\n```\n1. [ ] two\n  * [ ] three');
  expect(toggleTask(text, 2, true)).toBe('- [ ] one\n```\n- [ ] not a task\n```\n1. [x] two\n  * [x] three');
  expect(toggleTask(text, 3, true)).toBe(text);
});

test('a code block keeps its language (for highlighting), not its classes', () => {
  const tpl = document.createElement('template');
  tpl.innerHTML = '<pre><code class="chroma language-go display">package main</code></pre>';
  scrub(tpl.content);
  const code = tpl.content.querySelector('code');
  expect(code?.getAttribute('data-lang')).toBe('go');
  expect(code?.hasAttribute('class')).toBe(false);
});

test('rendered links to pages the app renders point at the app', () => {
  const root = document.createElement('div');
  const o = location.origin;
  root.innerHTML = `<a class="mention" href="${o}/alice">@alice</a> <a href="/acme/site/issues/3">#3</a> <a href="/acme/site/pulls/4/files">files</a>` +
    ' <a href="/acme/site/wiki/Home">wiki</a> <a href="https://example.com/x">out</a> <a href="/alice" target="_blank">tab</a>';
  appLinks(root, '');
  expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
    // A profile is a canonical route (the app's owner page): the link stays as Forgejo wrote it.
    `${o}/alice`, '/acme/site/issues/3', '/acme/site/pulls/4?tab=files', '/acme/site/wiki/Home', 'https://example.com/x', '/alice',
  ]);
});
