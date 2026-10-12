// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {CodeViewItem, CodeViewLineSelection, SelectedLineRange} from '@pierre/diffs';
import {CodeView, type CodeViewHandle, useStableCallback} from '@pierre/diffs/react';
import {useEffect, useMemo, useRef} from 'react';
import {useViewSize} from '../features/code/Lines.tsx';
import {fileContents, PierreProvider, renderOptions} from './PierreProvider.tsx';

/** 0-based, ordered, inclusive. */
export type LineRange = readonly [number, number];

interface FileSurfaceProps {
  name: string;
  text: string;
  /** The blob SHA. */
  sha: string;
  lines: number;
  scroller: HTMLDivElement | null;
  /** The selected lines (the URL's #L fragment), scrolled into view when they change from outside. */
  range: LineRange | undefined;
  onSelect: (range: LineRange) => void;
}

/** A file in Pierre's virtualized CodeView. No network reads here. */
export function FileSurface(props: FileSurfaceProps) {
  useViewSize(props.scroller);
  return <PierreProvider>{(plain) => <FileBody {...props} plain={plain}/>}</PierreProvider>;
}

function FileBody({name, text, sha, lines, range, onSelect, plain}: FileSurfaceProps & {plain: boolean}) {
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const id = `${sha}:${name}`;
  const items = useMemo<CodeViewItem<undefined>[]>(() => [{id, type: 'file', file: fileContents(sha, name, text, plain), version: 0}], [id, sha, name, text, plain]);
  // The range last picked in the view: it is already visible, so it must not scroll.
  const picked = useRef('');
  const select = useStableCallback((next: LineRange) => {
    picked.current = `${String(next[0])}-${String(next[1])}`;
    onSelect(next);
  });
  const start = range?.[0];
  const end = range?.[1];
  const selection = useMemo<CodeViewLineSelection | null>(() => start === undefined || end === undefined ? null : {id, range: {start: start + 1, end: end + 1}}, [id, start, end]);
  // Pierre owns the selection while a pointer drags it; the URL follows once the drag ends, and the view follows the
  // URL when it changes from outside.
  const onLineSelected = useStableCallback((next: SelectedLineRange | null) => {
    // Clicking the only selected line keeps it linked, as on GitHub.
    if (!next) viewer.current?.setSelectedLines(selection);
    else select([Math.min(next.start, next.end) - 1, Math.max(next.start, next.end) - 1]);
  });
  const pickLine = useStableCallback((n: number, extend: boolean) => {
    const from = extend ? start ?? n : n;
    select([Math.min(from, n), Math.max(from, n)]);
  });
  const options = useMemo(() => ({
    ...renderOptions, disableFileHeader: true, enableLineSelection: true, onLineSelected,
    onPostRender: (node: HTMLElement) => {
      // Keyboard and screen-reader access to line links, which Pierre offers to pointers only; Shift extends the range.
      for (const number of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-column-number]:not([role])') ?? []) {
        const n = Number(number.getAttribute('data-column-number'));
        if (!n) continue;
        number.setAttribute('role', 'link');
        number.setAttribute('aria-label', `Line ${String(n)}`);
        number.tabIndex = 0;
        number.onkeydown = (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          pickLine(n - 1, event.shiftKey);
        };
      }
    },
  }), [onLineSelected, pickLine]);
  useEffect(() => {
    viewer.current?.setSelectedLines(selection);
    if (start === undefined || picked.current === `${String(start)}-${String(end)}`) return;
    viewer.current?.scrollTo({type: 'line', id, lineNumber: start + 1, align: 'center'});
  }, [id, start, end, selection]);
  return <div role="region" aria-label={`${name}, ${String(lines)} ${lines === 1 ? 'line' : 'lines'}`}>
    <CodeView ref={viewer} items={items} className="h-view overflow-auto" options={options}/>
  </div>;
}
