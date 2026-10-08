// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Perf numbers: quantiles, a printed and attached summary per metric, and
// (NEXT_E2E_PERF_OUT) one JSON line per metric appended to a file, which
// tools/ci.sh collects into the run's report.

import {appendFileSync} from 'node:fs';
import {test} from '@playwright/test';
import {DB} from './env.ts';

export function quantile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? Number.NaN;
}

export const median = (values: number[]) => quantile(values, 0.5);

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function summary(values: number[]): Summary {
  return {n: values.length, p50: median(values), p95: quantile(values, 0.95), max: Math.max(...values)};
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));

/** Records a metric (samples in `unit`, more as JSON in `extra`): printed, attached to the test, appended to NEXT_E2E_PERF_OUT. */
export function record(metric: string, values: number[], extra: Record<string, unknown> = {}, unit = 'ms'): Summary {
  const s = summary(values);
  const text = `n=${String(s.n)} p50=${fmt(s.p50)} p95=${fmt(s.p95)} max=${fmt(s.max)} ${unit}`;
  test.info().annotations.push({type: metric, description: `${text}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`});
  console.log(`[perf ${DB}] ${metric}: ${text}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);
  const out = process.env.NEXT_E2E_PERF_OUT;
  if (out) appendFileSync(out, `${JSON.stringify({db: DB, metric, ...s, samples: values.map((v) => Math.round(v * 10) / 10), ...extra})}\n`);
  return s;
}
