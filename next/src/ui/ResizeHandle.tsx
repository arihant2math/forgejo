// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type KeyboardEvent, type PointerEvent, useRef} from 'react';

export interface ResizeHandleProps {
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  value: number;
  min: number;
  max: number;
  /** While dragging (every pointer move; keep it cheap: no React state). `handle` is this separator. */
  onResize: (value: number, handle: HTMLElement) => void;
  /** Once the drag or key press ends: persist. */
  onCommit: (value: number) => void;
}

const STEP = 16;

/**
 * A vertical splitter on the right edge of a pane (position its parent
 * relative). Drag it, or focus it and use the arrow keys.
 */
export function ResizeHandle({label, value, min, max, onResize, onCommit}: ResizeHandleProps) {
  const drag = useRef<{x: number; start: number; last: number} | undefined>(undefined);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {x: e.clientX, start: value, last: value};
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.start + e.clientX - d.x);
    e.currentTarget.setAttribute('aria-valuenow', String(d.last));
    onResize(d.last, e.currentTarget);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d) onCommit(d.last);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {ArrowLeft: value - STEP, ArrowRight: value + STEP, Home: min, End: max};
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const v = clamp(next);
    onResize(v, e.currentTarget);
    onCommit(v);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1 z-sticky w-2 cursor-col-resize touch-none"
    >
      {/* Instant in and out: the line follows the pointer, a fade would lag behind it. */}
      <div className="mx-auto h-full w-px group-hover:bg-accent group-active:bg-accent"/>
    </div>
  );
}
