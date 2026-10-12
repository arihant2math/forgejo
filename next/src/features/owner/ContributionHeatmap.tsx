// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useLayoutEffect, useRef, useState} from 'react';

const CELL = 10;
const STEP = 13;
const GUTTER = 28;
const TOP = 16;
const WEEKDAYS = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const;

function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const fill = (level: number) => `var(--contribution-default-bgColor-${String(level)})`;

/** The server reports 15-minute buckets; cells are local calendar days, Sunday first, as on GitHub. */
export function ContributionHeatmap({rows}: {rows: readonly {timestamp: number; contributions: number}[]}) {
  const [today] = useState(() => new Date());
  const scroller = useRef<HTMLDivElement>(null);
  // When the chart overflows, open on the latest weeks.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  }, []);
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364);
  first.setDate(first.getDate() - first.getDay());
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = dayKey(new Date(r.timestamp * 1000));
    counts.set(key, (counts.get(key) ?? 0) + r.contributions);
  }
  const days: {date: string; month: number; value: number}[] = [];
  for (let d = new Date(first); d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const date = dayKey(d);
    days.push({date, month: d.getMonth(), value: counts.get(date) ?? 0});
  }
  const max = Math.max(1, ...days.map((d) => d.value));
  const level = (v: number) => (v > 0 ? Math.min(4, Math.max(1, Math.ceil(v / max * 4))) : 0);
  const weeks = Math.ceil(days.length / 7);
  const months: {week: number; name: string}[] = [];
  for (let w = 0; w < weeks; w++) {
    const day = days[w * 7];
    if (!day || (w > 0 && days[(w - 1) * 7]?.month === day.month)) continue;
    // A partial first month too narrow for its name yields to the next one; a month starting in the last column has no room.
    if ((w === 0 && days[14]?.month !== day.month) || w === weeks - 1) continue;
    months.push({week: w, name: new Date(2000, day.month, 1).toLocaleDateString('en-US', {month: 'short'})});
  }
  const width = weeks * STEP;
  const height = TOP + 7 * STEP;
  return <figure className="flex flex-col gap-2 px-4 py-3">
    <figcaption className="text-sm text-muted">{days.reduce((n, d) => n + d.value, 0)} contributions in the last year</figcaption>
    <div className="flex">
      {/* Weekday labels stay outside the scroller so they remain visible while the weeks scroll. */}
      <svg aria-hidden width={GUTTER} height={height} className="shrink-0 text-xs text-muted">
        <g fill="currentColor">
          {WEEKDAYS.map(([row, name]) => <text key={name} x={0} y={TOP + row * STEP + CELL - 1}>{name}</text>)}
        </g>
      </svg>
      <div ref={scroller} role="group" aria-label="Contribution heatmap, scrollable" tabIndex={0} className="min-w-0 overflow-x-auto">
        <svg role="img" aria-label="Daily contribution heatmap" width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} className="block text-xs text-muted">
          <g aria-hidden fill="currentColor">
            {months.map((m) => <text key={m.week} x={m.week * STEP} y={TOP - 5}>{m.name}</text>)}
          </g>
          {days.map((d, i) => <rect key={d.date} x={Math.floor(i / 7) * STEP} y={TOP + (i % 7) * STEP} width={CELL} height={CELL} rx={2} fill={fill(level(d.value))}>
            <title>{`${d.date}: ${String(d.value)} contributions`}</title>
          </rect>)}
        </svg>
      </div>
    </div>
    <div aria-hidden className="flex items-center justify-end gap-1 text-xs text-muted">
      Less
      <svg width={5 * STEP} height={CELL} viewBox={`0 0 ${String(5 * STEP)} ${String(CELL)}`}>
        {[0, 1, 2, 3, 4].map((l) => <rect key={l} x={l * STEP} width={CELL} height={CELL} rx={2} fill={fill(l)}/>)}
      </svg>
      More
    </div>
  </figure>;
}
