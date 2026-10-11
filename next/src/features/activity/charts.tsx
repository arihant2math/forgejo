// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The activity pages' graphs: plain SVG (no chart library), coloured by the
// design tokens (fill-accent, fill-success, fill-danger: both themes), one
// path per series however many weeks it has (a contributor's whole history
// is one element). The SVG stretches to its box; text stays HTML (crisp at
// any width). Pointing at a column shows its value in the caption line.

import {type PointerEvent, type ReactNode, useState} from 'react';
import {cx} from '../../ui/index.ts';
import {niceMax} from './pulse.ts';

export interface Column {
  /** What the column is (its caption: "Week of Oct 4"). */
  label: string;
  value: number;
}

/** The SVG's coordinate width of one column (the gap between columns is a fifth of it). */
const STEP = 10;
const GAP = 2;
/** The SVG's coordinate height. */
const H = 100;

/** The bars of `values` (each a fraction of `max`) as one path, from the baseline `y0` upwards (dir -1) or down. */
export function barsPath(values: readonly number[], max: number, y0: number, dir: 1 | -1, height: number): string {
  const parts: string[] = [];
  values.forEach((v, i) => {
    if (!(v > 0) || !(max > 0)) return;
    const h = Math.max(0.5, Math.min(1, v / max) * height);
    const x = i * STEP + GAP / 2;
    parts.push(`M${String(x)} ${String(y0)}v${String(dir * h)}h${String(STEP - GAP)}v${String(-dir * h)}z`);
  });
  return parts.join('');
}

/** The column under the pointer. */
function useHover(n: number): [number | undefined, {onPointerMove: (e: PointerEvent<SVGSVGElement>) => void; onPointerLeave: () => void}] {
  const [at, setAt] = useState<number | undefined>(undefined);
  return [at, {
    onPointerMove: (e) => {
      const box = e.currentTarget.getBoundingClientRect();
      const i = Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * n);
      setAt(i >= 0 && i < n ? i : undefined);
    },
    onPointerLeave: () => {
      setAt(undefined);
    },
  }];
}

const heights = {sm: 'h-12', md: 'h-24', lg: 'h-40'} as const;

/**
 * Columns over time (commits per week). `caption`: the line above the graph when nothing is pointed at; `start`
 * and `end` label the axis below it.
 */
export function ColumnChart({label, columns, caption, unit, start, end, size = 'md'}: {
  label: string;
  columns: readonly Column[];
  caption?: ReactNode;
  /** The value's noun ("commits"). */
  unit: string;
  start?: string | undefined;
  end?: string | undefined;
  size?: keyof typeof heights;
}) {
  const values = columns.map((c) => c.value);
  const max = niceMax(Math.max(0, ...values));
  const [at, hover] = useHover(columns.length);
  const pointed = at === undefined ? undefined : columns[at];
  const w = Math.max(1, columns.length) * STEP;
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex h-5 items-center justify-between gap-2 text-sm text-muted tabular-nums">
        <span className="truncate">{pointed ? `${pointed.label}: ${pointed.value.toLocaleString()} ${unit}` : caption}</span>
        <span className="shrink-0 text-muted">{max.toLocaleString()}</span>
      </figcaption>
      <svg role="img" aria-label={label} viewBox={`0 0 ${String(w)} ${String(H)}`} preserveAspectRatio="none" className={cx('w-full touch-none', heights[size])} {...hover}>
        <path d={`M0 ${String(H)}H${String(w)}`} className="stroke-default" vectorEffect="non-scaling-stroke"/>
        {at !== undefined && <rect x={at * STEP} y={0} width={STEP} height={H} className="fill-control-transparent-hover"/>}
        <path d={barsPath(values, max, H, -1, H)} className="fill-accent"/>
      </svg>
      {(start ?? end) && <Axis start={start} end={end}/>}
    </figure>
  );
}

/** Additions above the axis, deletions below it (code frequency), on one scale. */
export function DivergingChart({label, columns, caption, start, end}: {
  label: string;
  columns: readonly {label: string; up: number; down: number}[];
  caption?: ReactNode;
  start?: string | undefined;
  end?: string | undefined;
}) {
  const max = niceMax(Math.max(0, ...columns.map((c) => Math.max(c.up, c.down))));
  const [at, hover] = useHover(columns.length);
  const pointed = at === undefined ? undefined : columns[at];
  const w = Math.max(1, columns.length) * STEP;
  const mid = H / 2;
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex h-5 items-center justify-between gap-2 text-sm text-muted tabular-nums">
        <span className="truncate">
          {pointed ?
            <>{pointed.label}: <span className="text-success">+{pointed.up.toLocaleString()}</span> <span className="text-danger">−{pointed.down.toLocaleString()}</span></> :
            caption}
        </span>
        <span className="shrink-0 text-muted">±{max.toLocaleString()}</span>
      </figcaption>
      <svg role="img" aria-label={label} viewBox={`0 0 ${String(w)} ${String(H)}`} preserveAspectRatio="none" className="h-40 w-full touch-none" {...hover}>
        {at !== undefined && <rect x={at * STEP} y={0} width={STEP} height={H} className="fill-control-transparent-hover"/>}
        <path d={barsPath(columns.map((c) => c.up), max, mid, -1, mid)} className="fill-success"/>
        <path d={barsPath(columns.map((c) => c.down), max, mid, 1, mid)} className="fill-danger"/>
        <path d={`M0 ${String(mid)}H${String(w)}`} className="stroke-emphasis" vectorEffect="non-scaling-stroke"/>
      </svg>
      {(start ?? end) && <Axis start={start} end={end}/>}
    </figure>
  );
}

export function ContributionHeatmap({rows}: {rows: readonly {timestamp: number; contributions: number}[]}) {
  const [end] = useState(() => new Date());
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364 - start.getUTCDay());
  const counts = new Map(rows.map((r) => [new Date(r.timestamp * 1000).toISOString().slice(0, 10), r.contributions]));
  const max = Math.max(1, ...rows.map((r) => r.contributions));
  const days = Array.from({length: Math.round((end.getTime() - start.getTime()) / 86400000) + 1}, (_, i) => {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return {date, value: counts.get(date) ?? 0};
  });
  return <figure className="px-3 py-3">
    <figcaption className="text-sm text-muted">{days.reduce((n, d) => n + d.value, 0)} contributions in the last year</figcaption>
    <svg role="img" aria-label="Daily contribution heatmap" viewBox={`0 0 ${String(Math.ceil(days.length / 7) * 10)} 70`} className="w-full">
      {days.map((d, i) => <rect key={d.date} x={Math.floor(i / 7) * 10} y={(i % 7) * 10} width={8} height={8} rx={1} className={d.value ? 'fill-accent' : 'fill-skeleton'} fillOpacity={d.value ? 0.25 + 0.75 * d.value / max : 1}><title>{`${d.date}: ${String(d.value)} contributions`}</title></rect>)}
    </svg>
  </figure>;
}

function Axis({start, end}: {start: string | undefined; end: string | undefined}) {
  return (
    <div aria-hidden className="flex justify-between gap-2 text-xs text-muted tabular-nums">
      <span>{start}</span>
      <span>{end}</span>
    </div>
  );
}

/** One horizontal bar (a share of the largest: the top committers). */
export function Meter({value, max, tone = 'accent'}: {value: number; max: number; tone?: 'accent' | 'success' | 'danger' | 'done'}) {
  const fill = {accent: 'fill-accent', success: 'fill-success', danger: 'fill-danger', done: 'fill-done'}[tone];
  const w = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return (
    <svg aria-hidden viewBox="0 0 100 4" preserveAspectRatio="none" className="h-2 w-full">
      <rect x={0} y={0} width={100} height={4} rx={1} className="fill-skeleton"/>
      <rect x={0} y={0} width={w} height={4} rx={1} className={fill}/>
    </svg>
  );
}

/** Two shares of a whole side by side (merged | open pull requests, closed | new issues): done, then open. */
export function Split({a, b, label}: {a: number; b: number; label: string}) {
  const total = a + b;
  const wa = total > 0 ? (a / total) * 100 : 0;
  return (
    <svg role="img" aria-label={label} viewBox="0 0 100 4" preserveAspectRatio="none" className="h-2 w-full">
      <rect x={0} y={0} width={100} height={4} className="fill-skeleton"/>
      {total > 0 && <rect x={0} y={0} width={wa} height={4} className="fill-done"/>}
      {total > 0 && <rect x={wa} y={0} width={100 - wa} height={4} className="fill-success"/>}
    </svg>
  );
}
