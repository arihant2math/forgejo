// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// `localStorage.profile = '1'` (PLAN §5.8): the next load renders with
// React's profiling build (react-dom/profiling, its own lazy chunk, never on
// the boot route) inside a <Profiler>, so the browser's performance panel
// shows React's tracks and every commit as a `react:commit` measure (detail:
// the phase and the render time). Remove the key to turn it off.

import {Profiler, type ProfilerOnRenderCallback, type ReactNode} from 'react';
import type {Root} from 'react-dom/client';

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _base, startTime, commitTime) => {
  try {
    performance.measure('react:commit', {start: startTime, end: commitTime, detail: {id, phase, actualDuration}});
  } catch {
    // No User Timing.
  }
};

/** createRoot from the profiling build, rendering `node` inside a Profiler. */
export async function profiledRoot(container: Element, node: ReactNode): Promise<Root> {
  const {createRoot} = await import('react-dom/profiling');
  const root = createRoot(container);
  root.render(<Profiler id="app" onRender={onRender}>{node}</Profiler>);
  return root;
}
