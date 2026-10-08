// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A virtualized list of fixed-height lines (file views, blame, logs) in the
// page's scroll container. Only the lines in view plus an overscan exist;
// each is a memoized component whose props are its index and its position,
// so a scroll frame mounts the lines coming into view and re-renders none of
// the others (no cascade). Lines move by transform only.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {memo, type ReactNode, useEffect, useImperativeHandle, useLayoutEffect, useState, type Ref} from 'react';

/** The height of one line (tokens.css --spacing-line). */
export const LINE = 20;

/** Stable (the virtualizer recomputes every position when its estimate function changes). */
const lineSize = () => LINE;

export interface LinesHandle {
  scrollToLine(index: number): void;
}

interface LinesProps {
  count: number;
  scroller: HTMLElement | null;
  /** Renders line `index`. Keep it stable (useCallback on the data it reads): a new function re-renders every line. */
  line: (index: number) => ReactNode;
  /** Scroll this line into view at mount (a #L12 link). */
  initial?: number | undefined;
  label: string;
  ref?: Ref<LinesHandle>;
  /** Keep the view at the end while it is there (a log that grows). */
  follow?: boolean;
}

const Line = memo(function Line({index, start, line}: {index: number; start: number; line: (index: number) => ReactNode}) {
  return (
    <div role="listitem" className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      {line(index)}
    </div>
  );
});

/** Where an element starts inside its scroll container (what is above it scrolls with it), px. */
export function useScrollMargin(scroller: HTMLElement | null): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    if (!el || !scroller) return undefined;
    const measure = () => {
      setMargin(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    };
    measure();
    // What is above may change height (a header that loads); the list itself never resizes what is above it.
    const ro = new ResizeObserver(measure);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => {
      ro.disconnect();
    };
  }, [el, scroller]);
  return [setEl, margin];
}

export const Lines = observer(function Lines({count, scroller, line, initial, label, ref, follow = false}: LinesProps) {
  const [at, offset] = useScrollMargin(scroller);
  const v = useVirtualizer({
    count,
    getScrollElement: () => scroller,
    estimateSize: lineSize,
    overscan: 30,
    scrollMargin: offset,
  });
  useImperativeHandle(ref, () => ({
    scrollToLine(index: number) {
      v.scrollToIndex(index, {align: 'center'});
    },
  }), [v]);
  useEffect(() => {
    if (initial !== undefined && scroller) v.scrollToIndex(initial, {align: 'center'});
    // Only at mount (and when the scroll container appears).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller]);
  // Following: the view stays at the end while the user is there (scrolling up stops it, scrolling back resumes).
  const [stick] = useState(() => ({on: true}));
  useEffect(() => {
    if (!follow || !scroller) return undefined;
    const onScroll = () => {
      stick.on = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < LINE * 3;
    };
    scroller.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [follow, scroller, stick]);
  useLayoutEffect(() => {
    if (follow && scroller && stick.on) scroller.scrollTop = scroller.scrollHeight;
  }, [count, follow, scroller, stick]);
  return (
    <div ref={at} role="list" aria-label={label} className="relative min-w-full" style={{height: v.getTotalSize()}}>
      {v.getVirtualItems().map((it) => <Line key={it.index} index={it.index} start={it.start - offset} line={line}/>)}
    </div>
  );
});
