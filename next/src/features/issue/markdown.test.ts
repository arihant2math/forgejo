// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import {createApp} from '../../app/store.ts';
import {scrub} from '../../app/trusted.ts';
import {CodeSource} from '../../code/source.ts';
import {fakeSession} from '../../test/fakeSession.ts';
import {appLinks, highlightBlocks, scrollMarkdownAnchor, toggleTask} from './Markdown.tsx';

test('markdown anchors scroll after rendering, with Forgejo heading prefixes', () => {
  const root = document.createElement('div');
  root.innerHTML = '<h2 id="user-content-install">Install</h2><h2 id="user-content-café">Café</h2>';
  const headings = [...root.querySelectorAll('h2')];
  const install = vi.fn();
  const cafe = vi.fn();
  const [first, second] = headings;
  if (!first || !second) throw new Error('Missing test headings');
  first.scrollIntoView = install;
  second.scrollIntoView = cafe;
  scrollMarkdownAnchor(root, 'install');
  scrollMarkdownAnchor(root, '#user-content-install');
  scrollMarkdownAnchor(root, 'caf%C3%A9');
  scrollMarkdownAnchor(root, '%invalid');
  expect(install).toHaveBeenCalledTimes(2);
  expect(cafe).toHaveBeenCalledWith({block: 'start'});
});

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
    `${o}/alice`, '/acme/site/issues/3', '/acme/site/pulls/4?tab=files', '/acme/site/wiki/Home', 'https://example.com/x', '/alice',
  ]);
});

test('fenced code is highlighted by its Shiki language name or alias, not taken for a file extension', async () => {
  const snippet = vi.spyOn(CodeSource.prototype, 'snippet').mockImplementation((_lang, text) =>
    Promise.resolve({spans: Uint32Array.of(text.length, 1), starts: Uint32Array.of(0, 1)}));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, fakeSession());
  const root = document.createElement('div');
  document.body.append(root);
  root.innerHTML = ['typescript', 'py', 'Shell', 'c++', 'suggestion'].map((l) => `<pre><code data-lang="${l}">${l}</code></pre>`).join('');
  highlightBlocks(app, root);
  await vi.waitFor(() => {
    expect(root.querySelectorAll('.text-syntax-keyword')).toHaveLength(4);
  });
  expect(snippet.mock.calls.map((c) => c[0])).toEqual(['typescript', 'python', 'shellscript', 'cpp']);
  root.remove();
  snippet.mockRestore();
});

test('blocks not highlighted yet are dropped when the markup goes away', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const snippet = vi.spyOn(CodeSource.prototype, 'snippet').mockImplementation((_lang, _text, signal) => {
    signals.push(signal);
    return new Promise(() => undefined);
  });
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, fakeSession());
  const root = document.createElement('div');
  root.innerHTML = '<pre><code data-lang="go">package main</code></pre>';
  const ctl = highlightBlocks(app, root);
  await vi.waitFor(() => {
    expect(signals).toHaveLength(1);
  });
  ctl?.abort();
  expect(signals[0]?.aborted).toBe(true);
  expect(highlightBlocks(app, document.createElement('div'))).toBeUndefined();
  snippet.mockRestore();
});
