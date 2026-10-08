// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type KeyboardEvent, type PointerEvent, useRef} from 'react';

export interface ResizeHandleProps {
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  value: number;
  min: number;
  max: number;
  /** While dragging (every pointer move; keep it cheap: no React state). */
  onResize: (value: number) => void;
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
    onResize(d.last);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d) onCommit(d.last);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    if (!delta) return;
    e.preventDefault();
    const v = clamp(value + delta);
    onResize(v);
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
      className="group absolute inset-y-0 -right-1 z-sticky w-2 cursor-col-resize outline-none"
    >
      <div className="interactive mx-auto h-full w-px group-hover:bg-border-strong group-focus-visible:bg-focus group-active:bg-accent"/>
    </div>
  );
}
