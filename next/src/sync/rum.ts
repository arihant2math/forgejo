// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Boot-route RUM collection; app/rum.ts batches reports.
// Fixed names and numeric values only: never collect user ids, text, or URLs.

import type {RUMEvent, RUMMark} from '../protocol/types.gen.ts';

const marked = new Set<string>();

/** First hidden/offline timestamps (performance.now; Infinity if none).
 * Exclude later boot/network marks to avoid timing user absence or outages; local offline marks still count.
 */
const since = {hidden: Number.POSITIVE_INFINITY, offline: Number.POSITIVE_INFINITY};
if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  if (document.visibilityState === 'hidden') since.hidden = 0;
  if (!navigator.onLine) since.offline = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') since.hidden = Math.min(since.hidden, performance.now());
  });
  addEventListener('offline', () => {
    since.offline = Math.min(since.offline, performance.now());
  });
}

/** First hidden/offline timestamps from performance.now(); Infinity if not disturbed. */
export function disturbedSince(): Readonly<{hidden: number; offline: number}> {
  return since;
}

export function markOnce(name: string): void {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    performance.mark(name);
  } catch {
    // No User Timing (tests).
  }
}

/** Measures milliseconds from start to the current performance timestamp. */
export function measure(name: string, start: number): void {
  try {
    performance.measure(name, {start, end: performance.now()});
  } catch {
    // No User Timing.
  }
}

/** Samples kept per mark until they are reported (a uniform sample of what happened beyond that). */
export const MAX_SAMPLES = 32;

interface Buffer {
  samples: Map<RUMMark, number[]>;
  seen: Map<RUMMark, number>;
  counts: Map<RUMEvent, number>;
  queueMax: number;
}

let buf: Buffer = fresh();

function fresh(): Buffer {
  return {samples: new Map(), seen: new Map(), counts: new Map(), queueMax: 0};
}

/** Records one timing (ms) of `mark`; negative or non-finite values are dropped. */
export function sample(mark: RUMMark, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const list = buf.samples.get(mark) ?? [];
  const n = (buf.seen.get(mark) ?? 0) + 1;
  buf.seen.set(mark, n);
  // Reservoir sampling: every sample has the same chance to be kept.
  if (list.length < MAX_SAMPLES) list.push(ms);
  else {
    const j = Math.floor(Math.random() * n);
    if (j < MAX_SAMPLES) list[j] = ms;
  }
  buf.samples.set(mark, list);
}

export function count(event: RUMEvent, n = 1): void {
  buf.counts.set(event, (buf.counts.get(event) ?? 0) + n);
}

/** The offline queue's current size (its largest since the last report is kept). */
export function queueDepth(n: number): void {
  if (n > buf.queueMax) buf.queueMax = n;
}

/** Returns and clears the collected values. */
export function takeCollected(): {samples: Map<RUMMark, number[]>; counts: Map<RUMEvent, number>; queueMax: number} {
  const b = buf;
  buf = fresh();
  return {samples: b.samples, counts: b.counts, queueMax: b.queueMax};
}

/** Puts back what could not be reported (the next report carries it). */
export function putBack(samples: Map<RUMMark, number[]>, counts: Map<RUMEvent, number>): void {
  for (const [m, list] of samples) for (const ms of list) sample(m, ms);
  for (const [e, n] of counts) count(e, n);
}
