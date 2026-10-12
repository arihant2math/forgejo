// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CodeView} from '@pierre/diffs/react';
import {useTheme} from '@primer/react';
import {useNavigate, useRouterState} from '@tanstack/react-router';
import {type ReactNode, useMemo} from 'react';
import {useViewSize} from '../features/code/Lines.tsx';
import {pierreHTMLSupported} from './pierreSupport.ts';
import {githubTheme, PierreProvider, primerCodeCSS, WorkerReady} from './PierreProvider.tsx';

/** A single VirtualizedFile in CodeView's measured viewport. No network reads here. */
export function FileSurface({name, text, cacheKey, scroller, children, fallback}: {
  name: string; text: string; cacheKey: string; scroller: HTMLDivElement | null; children: ReactNode; fallback: ReactNode;
}) {
  const hash = useRouterState({select: (s) => s.location.hash});
  const navigate = useNavigate();
  const {resolvedColorScheme} = useTheme();
  useViewSize(scroller);
  const items = useMemo(() => [{id: `${cacheKey}:${name}`, type: 'file' as const, file: {name, contents: text, cacheKey: `${cacheKey}:${name}`}, version: 0}], [name, text, cacheKey]);
  // Linked files retain real #L anchors in the light DOM, Shift+click ranges,
  // and the permalink/history menu. Pierre's numbers live in a shadow root.
  // Blame and these deep links deliberately share the accessible line renderer.
  if (!pierreHTMLSupported() || /^#?L\d/.test(hash)) return fallback;
  const pick = (n: number) => {void navigate({to: '.', hash: `L${String(n)}`, search: true, replace: true});};
  return <PierreProvider><WorkerReady fallback={fallback}>
    {children}
    <div role="list" aria-label={`${name}, ${String(text.split('\n').length - (text.endsWith('\n') ? 1 : 0))} lines`}>
      <CodeView items={items} className="h-view overflow-auto" options={{theme: githubTheme,
        themeType: resolvedColorScheme === 'dark' ? 'dark' : 'light', disableFileHeader: true,
        unsafeCSS: primerCodeCSS, enableLineSelection: true, tokenizeMaxLineLength: 400, tokenizeMaxLength: 500_000,
        onLineNumberClick: (line) => {pick(line.lineNumber);},
        onPostRender: (node) => {
          // Keep line-number accessible names and keyboard links, not just pointer selection.
          for (const number of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-column-number]') ?? []) {
            const n = Number(number.getAttribute('data-column-number'));
            if (!n) continue;
            number.setAttribute('role', 'link');
            number.setAttribute('aria-label', `Line ${String(n)}`);
            number.tabIndex = 0;
            number.onkeydown = (event) => {if (event.key === 'Enter') {event.preventDefault(); pick(n);}};
          }
        },
      }} onSelectedLinesChange={(selection) => {
        if (!selection) return;
        const {start, end} = selection.range;
        void navigate({to: '.', hash: start === end ? `L${String(start)}` : `L${String(Math.min(start, end))}-L${String(Math.max(start, end))}`, search: true, replace: true});
      }}/>
    </div>
  </WorkerReady></PierreProvider>;
}
