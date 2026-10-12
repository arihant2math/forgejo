// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// localStorage.profile = '1' enables React's profiling build on the next load; remove the key to disable.
// The lazy profiling chunk stays off the boot route and records react:commit measures.

import {Profiler, type ProfilerOnRenderCallback, type ReactNode} from 'react';
import type {Root} from 'react-dom/client';

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _base, startTime, commitTime) => {
  try {
    performance.measure('react:commit', {start: startTime, end: commitTime, detail: {id, phase, actualDuration}});
  } catch {
    // No User Timing.
  }
};

export async function profiledRoot(container: Element, node: ReactNode): Promise<Root> {
  const {createRoot} = await import('react-dom/profiling');
  const root = createRoot(container);
  root.render(<Profiler id="app" onRender={onRender}>{node}</Profiler>);
  return root;
}
