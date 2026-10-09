// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Server-rendered markdown (an issue body, a comment, a README): put in
// through the Trusted Types gate (app/trusted.ts) after every change of the
// HTML, never by React. Links to pages this UI renders (issues, pull
// requests, lists, repositories, code, people: app/paths.ts nextPathOf)
// navigate in place; everything else is a normal link.

import {useRouter} from '@tanstack/react-router';
import {type ChangeEvent, type MouseEvent, useLayoutEffect, useRef} from 'react';
import {nextPathOf} from '../../app/paths.ts';
import {type App, useApp} from '../../app/store.ts';
import {setMarkup} from '../../app/trusted.ts';
import {paintTokens, Prose} from '../../ui/index.ts';

/**
 * `onTask`: the task-list checkboxes can be ticked (the viewer may edit the text): called with the task's index
 * in the text and its new state (the caller edits the markdown). Without it they stay inert.
 */
export function Markdown({html, onTask}: {html: string; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const app = useApp();
  const tasks = Boolean(onTask);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setMarkup(ref.current, html);
    highlightBlocks(app, ref.current);
    if (tasks) {
      ref.current.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
        box.disabled = false;
        box.dataset.task = String(i);
        box.setAttribute('aria-label', `Task ${String(i + 1)}`);
      });
    }
  }, [app, html, tasks]);
  const onChange = (e: ChangeEvent<HTMLDivElement>) => {
    const box = e.target as HTMLInputElement;
    if (!onTask || box.type !== 'checkbox' || box.dataset.task === undefined) return;
    onTask(Number(box.dataset.task), box.checked);
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest('a');
    if (!a?.href || a.target) return;
    const url = new URL(a.href);
    const sub = app.config.app_sub_url;
    if (url.origin !== location.origin || !url.pathname.startsWith(`${sub}/`)) return;
    // The app's page for it (nextPathOf refuses encoded dots, slashes and backslashes, which the router would
    // decode into another path than the one checked).
    const to = nextPathOf(url.pathname.slice(sub.length));
    if (!to) return;
    e.preventDefault();
    // As an href (already encoded: the router takes it as is), with the link's query and fragment.
    const [path = '/', query = ''] = to.split('?');
    const search = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(query)) search.set(k, v);
    const q = search.toString();
    void router.navigate({href: `${sub}${path}${q ? `?${q}` : ''}${url.hash}`});
  };
  return <Prose ref={ref} onClick={onClick} onChange={tasks ? onChange : undefined}/>;
}

/**
 * Ticks or unticks the `index`-th task ("- [ ] …", "1. [x] …") of markdown, outside fenced code (the order
 * Forgejo renders the checkboxes in). The text unchanged when there is no such task.
 */
export function toggleTask(text: string, index: number, checked: boolean): string {
  const lines = text.split('\n');
  let fence: string | undefined;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || f.startsWith(fence))) {
      fence = fence ? undefined : f;
      continue;
    }
    if (fence) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line);
    if (!m) continue;
    if (n++ === index) {
      lines[i] = `${m[1] ?? ''}${checked ? 'x' : ' '}${m[3] ?? ''}${line.slice(m[0].length)}`;
      return lines.join('\n');
    }
  }
  return text;
}

/**
 * Highlights the fenced code blocks of rendered markdown with a language (data-lang, trusted.ts) in the code
 * worker, as files and diffs are (the code chunk loads only when there is such a block).
 */
function highlightBlocks(app: App, root: HTMLElement): void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[data-lang]')];
  if (!blocks.length) return;
  void import('../../code/source.ts').then(({codeSource, langOf}) => {
    const src = codeSource(app);
    if (!src) return;
    for (const code of blocks) {
      const lang = langOf(`x.${code.dataset.lang ?? ''}`);
      const text = code.textContent;
      if (!lang || !text) continue;
      void src.snippet(lang, text).then((hl) => {
        // Still the same block (the markup is replaced on every change of the HTML).
        if (hl && code.isConnected && code.textContent === text) paintTokens(code, hl);
      });
    }
  }).catch(() => undefined);
}
