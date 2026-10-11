// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How far along something is (a milestone: its closed issues of all): a thin bar, filled in the success colour.
 * `label` names it for assistive technology ("3 of 8 issues closed"); the page shows the numbers in words too.
 */
export function ProgressBar({value, max, label}: {value: number; max: number; label: string}) {
  const done = max > 0 ? Math.min(max, Math.max(0, value)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={Math.max(max, 0)} aria-valuenow={done}
      className="flex h-2 w-full overflow-hidden rounded-full bg-selected">
      {/* Grow factors, not widths: the bar lays out without a computed length. */}
      <span className="block h-full bg-success" style={{flexGrow: done}}/>
      <span className="block h-full" style={{flexGrow: Math.max(max, 0) - done}}/>
    </div>
  );
}
