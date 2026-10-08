// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// RUM (PLAN §5.8), the reporting half (loaded when idle after the first
// paint, never on the boot route): batches what sync/rum.ts collected and
// the boot marks of the performance timeline into POST /-/sync/rum reports
// (B8, protocol.RUMReport).
//
// The contract: `marks` maps a known name to one value in ms (0–10 min),
// `events` a known name to a count (0–1000); ≤ 8 KiB; JSON; anonymous;
// 10 reports a minute per client address. So:
//
//   * boot marks (ms from `appStart`) go once per page load, in the first
//     report after they happened;
//   * mutation and interaction samples go one per mark per report: a flush
//     sends at most MAX_REPORTS reports, and what does not fit waits for the
//     next one (sync/rum.ts keeps a uniform sample per mark);
//   * INP: the worst interaction (Event Timing, by interactionId) of each
//     visible period, reported when the page is hidden;
//   * a flush every FLUSH_MS while something is waiting, and when the page
//     is hidden (fetch keepalive); nothing while offline; a 429 waits for its
//     Retry-After, other refusals drop the batch.
//
// Privacy: only the fixed names and numbers; no identifiers, URLs, texts or
// credentials (`credentials: 'omit'`, no Authorization header).
//
// The offline queue's depth has no slot in protocol.RUMReport (backend
// follow-up): its largest value per period is put on the performance
// timeline as `rum:queueDepth` (detail = depth), for profiling.

import {
  type RUMEvent, type RUMMark, type RUMReport,
  RUMCaughtUp, RUMDataOpen, RUMFirstPaintFromCache, RUMHydrateAll, RUMHydrateRoute, RUMInteraction, RUMWSOpen,
} from '../protocol/types.gen.ts';
import {putBack, sample, takeCollected} from '../sync/rum.ts';

/** Boot marks: the report's name → the performance entry (a mark, or a measure's end). */
const BOOT: readonly (readonly [RUMMark, string])[] = [
  [RUMFirstPaintFromCache, 'firstPaintFromCache'],
  [RUMDataOpen, 'dataOpen'],
  [RUMWSOpen, 'wsOpen'],
  [RUMCaughtUp, 'caughtUp'],
  [RUMHydrateRoute, 'hydrate:route'],
  [RUMHydrateAll, 'hydrate:all'],
];

export const FLUSH_MS = 60_000;
export const MAX_REPORTS = 3;
const MAX_MS = 10 * 60_000;

export interface RumEnv {
  /** POST target: sitePath(config, '/-/sync/rum'). */
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Builds up to `max` reports from boot marks, samples and counts; what does not fit is returned. */
export function buildReports(boot: Map<RUMMark, number>, samples: Map<RUMMark, number[]>, counts: Map<RUMEvent, number>, max = MAX_REPORTS): {reports: RUMReport[]; rest: Map<RUMMark, number[]>} {
  const reports: RUMReport[] = [];
  const queues = new Map([...samples].map(([m, l]) => [m, l.filter((x) => x <= MAX_MS)] as const));
  for (let n = 0; n < max; n++) {
    const marks: Record<RUMMark, number> = {};
    if (n === 0) for (const [m, ms] of boot) if (ms >= 0 && ms <= MAX_MS) marks[m] = round(ms);
    for (const [m, list] of queues) {
      const ms = list.shift();
      if (ms !== undefined && !(m in marks)) marks[m] = round(ms);
      else if (ms !== undefined) list.unshift(ms);
    }
    const events: Record<RUMEvent, number> = {};
    if (n === 0) for (const [e, c] of counts) if (c > 0) events[e] = Math.min(c, 1000);
    if (Object.keys(marks).length === 0 && Object.keys(events).length === 0) break;
    reports.push({...(Object.keys(marks).length ? {marks} : {}), ...(Object.keys(events).length ? {events} : {})});
  }
  const rest = new Map([...queues].filter(([, l]) => l.length > 0));
  return {reports, rest};
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** INP of a period: the worst interaction, skipping one per 50 (the web-vitals approximation of p98). */
export function inp(durations: number[]): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(durations.length / 50))];
}

export class RumReporter {
  private readonly bootSent = new Set<RUMMark>();
  private readonly interactions = new Map<number, number>();
  private blockedUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly cleanups: (() => void)[] = [];
  private sending = false;
  private readonly env: RumEnv;

  constructor(env: RumEnv) {
    this.env = env;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush(false);
    }, FLUSH_MS);
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          if (!e.interactionId) continue;
          this.interactions.set(e.interactionId, Math.max(this.interactions.get(e.interactionId) ?? 0, e.duration));
        }
      });
      po.observe({type: 'event', buffered: true, durationThreshold: 16} as PerformanceObserverInit);
      this.cleanups.push(() => {
        po.disconnect();
      });
    } catch {
      // No Event Timing (Safari, Firefox < 144): no INP.
    }
    const hidden = () => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', hidden);
    this.cleanups.push(() => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', hidden);
    });
    // The boot marks of this load, once the first sync is in.
    setTimeout(() => {
      void this.flush(false);
    }, 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.cleanups.splice(0)) c();
  }

  /** The boot marks not reported yet, in ms from appStart. */
  private bootMarks(): Map<RUMMark, number> {
    const out = new Map<RUMMark, number>();
    const start = performance.getEntriesByName('appStart')[0]?.startTime;
    if (start === undefined) return out;
    for (const [name, entry] of BOOT) {
      if (this.bootSent.has(name)) continue;
      const e = performance.getEntriesByName(entry)[0];
      if (e) out.set(name, e.startTime + e.duration - start);
    }
    return out;
  }

  /** Sends what is waiting. `final`: the page is being hidden (the period's INP goes too). */
  async flush(final: boolean): Promise<void> {
    const now = (this.env.now ?? Date.now)();
    if (this.sending || now < this.blockedUntil || !navigator.onLine) return;
    if (final) {
      const v = inp([...this.interactions.values()]);
      if (v !== undefined) sample(RUMInteraction, v);
      this.interactions.clear();
    }
    const got = takeCollected();
    if (got.queueMax > 0) {
      try {
        performance.mark('rum:queueDepth', {detail: got.queueMax});
      } catch {
        // No User Timing.
      }
    }
    const boot = this.bootMarks();
    const {reports, rest} = buildReports(boot, got.samples, got.counts);
    if (reports.length === 0) return;
    this.sending = true;
    let refused = false;
    try {
      for (const [n, report] of reports.entries()) {
        const status = await this.post(report, final);
        if (status === 429 || status === 0) {
          // Rate-limited or not sent: everything not reported waits (429: a minute).
          if (status === 429) this.blockedUntil = now + 60_000;
          const left = reports.slice(n);
          const samples = new Map<RUMMark, number[]>();
          for (const r of left) for (const [m, ms] of Object.entries(r.marks ?? {})) if (!boot.has(m)) samples.set(m, [...samples.get(m) ?? [], ms]);
          for (const [m, l] of rest) samples.set(m, [...samples.get(m) ?? [], ...l]);
          putBack(samples, n === 0 ? got.counts : new Map<RUMEvent, number>());
          refused = true;
          break;
        }
        // Delivered, or refused for good (4xx): either way not sent again.
        if (n === 0) for (const m of boot.keys()) this.bootSent.add(m);
      }
      if (!refused) putBack(rest, new Map<RUMEvent, number>());
    } finally {
      this.sending = false;
    }
  }

  /** The status, or 0 when the request did not complete. */
  private async post(report: RUMReport, keepalive: boolean): Promise<number> {
    try {
      const res = await (this.env.fetch ?? fetch)(this.env.url, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(report),
        credentials: 'omit', cache: 'no-store', keepalive,
      });
      return res.status;
    } catch {
      return 0;
    }
  }
}

let reporter: RumReporter | undefined;

/** Starts reporting for this page (once). */
export function startRum(url: string): RumReporter {
  if (!reporter) {
    reporter = new RumReporter({url});
    reporter.start();
  }
  return reporter;
}
