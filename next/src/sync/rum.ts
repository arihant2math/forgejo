// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// RUM (PLAN §5.8), the collecting half, which is on the boot route and
// stays tiny:
//
//   * boot marks are User Timing entries: `appStart` (the boot script, F1),
//     `dataOpen`, `wsOpen` and `caughtUp` (F2), the measures
//     `hydrate:route` / `hydrate:all` (data.ts) and `firstPaintFromCache`
//     (the shell, F3); app/rum.ts reads them from the performance timeline;
//   * samples (`sample`): one timing per mutation stage (the intents'
//     localApplied → acked → confirmed) and per interaction;
//   * counts (`count`): the offline queue's outcomes and conflicts;
//   * the offline queue's depth (`queueDepth`): its largest size since the
//     last report.
//
// Values are numbers keyed by fixed names (protocol.RUMMark / RUMEvent):
// never ids, texts, URLs or anything else of the user. app/rum.ts batches
// them to POST /-/sync/rum.

import type {RUMEvent, RUMMark} from '../protocol/types.gen.ts';

const marked = new Set<string>();

/** Marks `name` the first time it happens in this page. */
export function markOnce(name: string): void {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    performance.mark(name);
  } catch {
    // No User Timing (tests).
  }
}

/** A measure from `start` (a mark name or a timestamp) to now. */
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

/** Counts `n` occurrences of `event`. */
export function count(event: RUMEvent, n = 1): void {
  buf.counts.set(event, (buf.counts.get(event) ?? 0) + n);
}

/** The offline queue's current size (its largest since the last report is kept). */
export function queueDepth(n: number): void {
  if (n > buf.queueMax) buf.queueMax = n;
}

/** What was collected since the last call, emptied. */
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
