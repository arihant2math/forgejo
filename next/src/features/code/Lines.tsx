// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Memoized fixed-height rows prevent scroll updates from re-rendering lines already in view.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {memo, type ReactNode, useEffect, useImperativeHandle, useLayoutEffect, useState, type Ref} from 'react';

/** The height of one line (tokens.css --spacing-line). */
export const LINE = 20;

/** Changing the estimate function forces the virtualizer to recompute every position. */
const lineSize = () => LINE;

export interface LinesHandle {
  scrollToLine(index: number): void;
}

interface LinesProps {
  count: number;
  scroller: HTMLElement | null;
  /** Keep this callback stable: changing it re-renders every line. */
  line: (index: number) => ReactNode;
  /** Scroll this line into view at mount (a #L12 link). */
  initial?: number | undefined;
  label: string;
  ref?: Ref<LinesHandle>;
  /** Follow growing logs until the user scrolls up; resume when they return to the end. */
  follow?: boolean;
}

const Line = memo(function Line({index, start, line}: {index: number; start: number; line: (index: number) => ReactNode}) {
  return (
    <div role="listitem" className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      {line(index)}
    </div>
  );
});

/** Publishes the scroll container's size as --view-width / --view-height (the w-view and h-view utilities). */
export function useViewSize(scroller: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!scroller) return undefined;
    const set = () => {
      scroller.style.setProperty('--view-width', `${String(scroller.clientWidth)}px`);
      scroller.style.setProperty('--view-height', `${String(scroller.clientHeight)}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(scroller);
    return () => {
      ro.disconnect();
    };
  }, [scroller]);
}

/** Returns the element's offset in its scroll container, in pixels. `watch`: an ancestor whose content above the element moves it (default: its parent). */
export function useScrollMargin(scroller: HTMLElement | null, watch?: (el: HTMLElement) => Element | null): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    if (!el || !scroller) return undefined;
    const measure = () => {
      setMargin(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    };
    measure();
    // Observe the parent: loading headers change the offset without resizing the list.
    const ro = new ResizeObserver(measure);
    const watched = watch ? watch(el) : el.parentElement;
    if (watched) ro.observe(watched);
    return () => {
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `watch` is a fixed lookup
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
  // Confine horizontal scrolling to the code; vertical scrolling belongs to the page.
  return (
    <div className="overflow-x-auto overflow-y-hidden">
      <div ref={at} role="list" aria-label={label} className="relative min-w-full" style={{height: v.getTotalSize()}}>
        {v.getVirtualItems().map((it) => <Line key={it.index} index={it.index} start={it.start - offset} line={line}/>)}
      </div>
    </div>
  );
});
