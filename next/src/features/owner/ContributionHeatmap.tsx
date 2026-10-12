// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';

export function ContributionHeatmap({rows}: {rows: readonly {timestamp: number; contributions: number}[]}) {
  const [end] = useState(() => new Date());
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364 - start.getUTCDay());
  const counts = new Map(rows.map((r) => [new Date(r.timestamp * 1000).toISOString().slice(0, 10), r.contributions]));
  const days = Array.from({length: Math.round((end.getTime() - start.getTime()) / 86400000) + 1}, (_, i) => {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return {date, value: counts.get(date) ?? 0};
  });
  const max = Math.max(1, ...days.map((d) => d.value));
  return <figure className="flex flex-col gap-2 px-4 py-3">
    <figcaption className="text-sm text-muted">{days.reduce((n, d) => n + d.value, 0)} contributions in the last year</figcaption>
    <svg role="img" aria-label="Daily contribution heatmap" viewBox={`0 0 ${String(Math.ceil(days.length / 7) * 10)} 70`} className="w-full">
      {days.map((d, i) => {
        const level = d.value > 0 ? Math.min(4, Math.max(1, Math.ceil(d.value / max * 4))) : 0;
        return <rect key={d.date} x={Math.floor(i / 7) * 10} y={(i % 7) * 10} width={8} height={8} rx={1} fill={`var(--contribution-default-bgColor-${String(level)})`}><title>{`${d.date}: ${String(d.value)} contributions`}</title></rect>;
      })}
    </svg>
  </figure>;
}
