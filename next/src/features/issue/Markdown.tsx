// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Insert server HTML through the Trusted Types gate; app links also work in new tabs.

import {useRouter, useRouterState} from '@tanstack/react-router';
import {type MouseEvent, useEffect, useEffectEvent, useLayoutEffect, useRef} from 'react';
import {nextPathOf} from '../../app/paths.ts';
import {type App, useApp} from '../../app/store.ts';
import {setMarkup} from '../../app/trusted.ts';
import {paintTokens} from '../../code/parts.tsx';

/** onTask receives the checkbox's index in source order and new state; omitted callbacks leave tasks inert. */
export function Markdown({html, onTask}: {html: string; onTask?: ((index: number, checked: boolean) => void) | undefined}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const app = useApp();
  const tasks = Boolean(onTask);
  const hash = useRouterState({select: (s) => s.location.hash});
  useLayoutEffect(() => {
    if (!ref.current) return;
    setMarkup(ref.current, html);
    appLinks(ref.current, app.config.app_sub_url);
    highlightBlocks(app, ref.current);
    if (tasks) {
      ref.current.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
        box.disabled = false;
        box.dataset.task = String(i);
        box.setAttribute('aria-label', `Task ${String(i + 1)}`);
      });
    }
  }, [app, html, tasks]);
  useLayoutEffect(() => {
    if (!hash || !ref.current) return;
    scrollMarkdownAnchor(ref.current, hash);
  }, [hash, html]);
  // Native checkboxes are outside React; its synthetic onChange does not handle them.
  const tick = useEffectEvent((i: number, checked: boolean) => {
    onTask?.(i, checked);
  });
  useEffect(() => {
    const root = ref.current;
    if (!root || !tasks) return undefined;
    const onChange = (e: Event) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || box.dataset.task === undefined) return;
      tick(Number(box.dataset.task), box.checked);
    };
    root.addEventListener('change', onChange);
    return () => {
      root.removeEventListener('change', onChange);
    };
  }, [tasks]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest('a');
    if (!a?.href || a.target) return;
    const url = new URL(a.href);
    const sub = app.config.app_sub_url;
    if (url.origin !== location.origin || !url.pathname.startsWith(`${sub}/`)) return;
    // Reject encoded separators and dots so router decoding cannot change the validated path.
    const site = url.pathname.slice(sub.length);
    const to = /^\/-\/next\/(?!assets\/)/.test(site) && !/%(?:2e|2f|5c)/i.test(site) ? site : nextPathOf(site);
    if (!to) return;
    e.preventDefault();
    // href is already encoded; the router must not encode it again.
    const [path = '/', query = ''] = to.split('?');
    const search = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(query)) search.set(k, v);
    const q = search.toString();
    void router.navigate({href: `${sub}${path}${q ? `?${q}` : ''}${url.hash}`});
  };
  return <div className="markdown-body" ref={ref} onClick={onClick}/>;
}

export function scrollMarkdownAnchor(root: HTMLElement, hash: string): void {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return;
  }
  const targets = [...root.querySelectorAll<HTMLElement>('[id]')];
  const target = targets.find((el) => el.id === id) ?? targets.find((el) => el.id === `user-content-${id}`);
  target?.scrollIntoView({block: 'start'});
}

/** Rewrite app-owned links so middle-clicks and new tabs stay in the app; leave other links untouched. */
export function appLinks(root: HTMLElement, sub: string): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (a.target || !a.href) continue;
    const url = new URL(a.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(`${sub}/`)) continue;
    const site = url.pathname.slice(sub.length);
    const to = nextPathOf(site);
    if (!to || to === site) continue;
    const [path = '/', query = ''] = to.split('?');
    const search = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(query)) search.set(k, v);
    const q = search.toString();
    a.setAttribute('href', `${sub}${path}${q ? `?${q}` : ''}${url.hash}`);
  }
}

/** Toggle a task in Forgejo's checkbox order, excluding fenced code; return unchanged text if absent. */
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
        // Ignore results for markup replaced while highlighting.
        if (hl && code.isConnected && code.textContent === text) paintTokens(code, hl);
      });
    }
  }).catch(() => undefined);
}
