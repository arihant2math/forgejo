// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Anonymous RUM reports contain only fixed names and numbers, never identifiers, URLs, text or credentials.
// Protocol limits: marks in ms (0–10 min), event counts (0–1000), JSON ≤ 8 KiB, 10 reports/minute per address.
// Tabs share a lower browser-wide budget; retry network/5xx failures and honor Retry-After on 429.
// Boot marks go once per load, excluding hidden/offline distortion; INP covers each visible period.

import {
  type RUMEvent, type RUMMark, type RUMReport,
  RUMCaughtUp, RUMDataOpen, RUMFirstPaintFromCache, RUMHydrateAll, RUMHydrateRoute, RUMInteraction, RUMWSOpen,
} from '../protocol/types.gen.ts';
import {disturbedSince, putBack, sample, takeCollected} from '../sync/rum.ts';
import {netSignal} from '../sync/net.ts';

/** Report name, performance entry and network-dependency flag. */
const BOOT: readonly (readonly [RUMMark, string, boolean])[] = [
  [RUMFirstPaintFromCache, 'firstPaintFromCache', false],
  [RUMDataOpen, 'dataOpen', false],
  [RUMWSOpen, 'wsOpen', true],
  [RUMCaughtUp, 'caughtUp', true],
  [RUMHydrateRoute, 'hydrate:route', false],
  [RUMHydrateAll, 'hydrate:all', false],
];

export const FLUSH_MS = 60_000;
export const MAX_REPORTS = 3;
/** Reports a minute for all tabs of this browser (the server allows 10 per address). */
export const TAB_BUDGET = 6;
const MAX_MS = 10 * 60_000;
/** Bound connection occupancy for stalled reports (ms). */
const POST_MS = 15_000;
const BUDGET_KEY = 'forgejo-next:rum';

export interface RumEnv {
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** Builds up to `max` reports from boot marks, samples and counts; what does not fit is returned. */
export function buildReports(boot: Map<RUMMark, number>, samples: Map<RUMMark, number[]>, counts: Map<RUMEvent, number>, max = MAX_REPORTS): {reports: RUMReport[]; rest: Map<RUMMark, number[]>} {
  const reports: RUMReport[] = [];
  const queues = new Map([...samples].map(([m, l]) => [m, l.filter((x) => x <= MAX_MS)] as const));
  for (let n = 0; n < max; n++) {
    const marks: Record<RUMMark, number> = {};
    if (n === 0) for (const [m, ms] of boot) if (ms >= 0 && ms <= MAX_MS) marks[m] = Math.round(ms);
    for (const [m, list] of queues) {
      const ms = list.shift();
      if (ms !== undefined && !(m in marks)) marks[m] = Math.round(ms);
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

/** INP of a period: the worst interaction, skipping one per 50 (the web-vitals approximation of p98). */
export function inp(durations: number[]): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(durations.length / 50))];
}

/** Retry-After in ms (seconds or an HTTP date), 60 s when absent or unreadable. */
function retryAfter(res: Response | undefined, now: number): number {
  const v = res?.headers.get('Retry-After') ?? '';
  const s = Number(v);
  if (v !== '' && Number.isFinite(s)) return Math.max(1000, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(1000, at - now) : 60_000;
}

export class RumReporter {
  private readonly bootSent = new Set<RUMMark>();
  private readonly interactions = new Map<number, number>();
  private blockedUntil = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
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
    this.first = setTimeout(() => {
      void this.flush(false);
    }, 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    for (const c of this.cleanups.splice(0)) c();
  }

  private now(): number {
    return (this.env.now ?? Date.now)();
  }

  /** Unreported boot marks in ms from appStart, excluding hidden/offline distortion. */
  private bootMarks(): Map<RUMMark, number> {
    const out = new Map<RUMMark, number>();
    const start = performance.getEntriesByName('appStart')[0]?.startTime;
    if (start === undefined) return out;
    const since = disturbedSince();
    for (const [name, entry, network] of BOOT) {
      if (this.bootSent.has(name)) continue;
      const e = performance.getEntriesByName(entry)[0];
      if (!e) continue;
      const end = e.startTime + e.duration;
      if (end > since.hidden || (network && end > since.offline)) {
        this.bootSent.add(name); // distorted: never reported
        continue;
      }
      out.set(name, end - start);
    }
    return out;
  }

  /** Reserves slots across tabs for the rolling one-minute budget. */
  private slots(n: number): number {
    const storage = this.env.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const now = this.now();
    if (!storage) return Math.min(n, 1); // no storage: this tab alone, sparingly
    try {
      const raw: unknown = JSON.parse(storage.getItem(BUDGET_KEY) ?? '[]');
      const recent = (Array.isArray(raw) ? raw : []).filter((t): t is number => typeof t === 'number' && t > now - 60_000 && t <= now);
      const take = Math.max(0, Math.min(n, TAB_BUDGET - recent.length));
      storage.setItem(BUDGET_KEY, JSON.stringify([...recent, ...Array.from({length: take}, () => now)]));
      return take;
    } catch {
      return Math.min(n, 1); // no storage: this tab alone, sparingly
    }
  }

  /** On hide, includes period INP and starts all keepalive reports together. */
  async flush(final: boolean): Promise<void> {
    if (final) {
      // Buffer INP before checking whether this flush can send.
      const v = inp([...this.interactions.values()]);
      if (v !== undefined) sample(RUMInteraction, v);
      this.interactions.clear();
    }
    const now = this.now();
    // Keepalive hide requests must not wait for an in-flight periodic flush.
    if ((this.sending && !final) || now < this.blockedUntil || !navigator.onLine) return;
    const got = takeCollected();
    // Queue depth has no protocol field; keep its maximum on the profiling timeline only.
    if (got.queueMax > 0) {
      try {
        performance.mark('rum:queueDepth', {detail: got.queueMax});
      } catch {
        // No User Timing.
      }
    }
    const boot = this.bootMarks();
    const built = buildReports(boot, got.samples, got.counts);
    const allowed = this.slots(built.reports.length);
    const reports = built.reports.slice(0, allowed);
    const back = (left: RUMReport[], counts: boolean) => {
      const samples = new Map<RUMMark, number[]>();
      for (const r of left) for (const [m, ms] of Object.entries(r.marks ?? {})) if (!boot.has(m)) samples.set(m, [...samples.get(m) ?? [], ms]);
      putBack(samples, counts ? got.counts : new Map<RUMEvent, number>());
    };
    back(built.reports.slice(allowed), reports.length === 0);
    putBack(built.rest, new Map<RUMEvent, number>());
    if (reports.length === 0) return;
    const nested = this.sending;
    this.sending = true;
    try {
      // Only requests started on hide can outlive the page.
      const answers = final ? await Promise.all(reports.map((r) => this.post(r, true))) : [];
      for (const [n, report] of reports.entries()) {
        const res = final ? answers[n] : await this.post(report, false);
        const status = res?.status ?? 0;
        if (status === 0 || status === 429 || status >= 500) {
          if (status === 429) this.blockedUntil = now + retryAfter(res, now);
          back(final ? [report] : reports.slice(n), n === 0);
          if (!final) break;
          continue;
        }
        // Other 4xx refusals are permanent; do not resend.
        if (n === 0) for (const m of boot.keys()) this.bootSent.add(m);
      }
    } finally {
      if (!nested) this.sending = false;
    }
  }

  private async post(report: RUMReport, keepalive: boolean): Promise<Response | undefined> {
    try {
      return await (this.env.fetch ?? fetch)(this.env.url, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(report),
        credentials: 'omit', cache: 'no-store', keepalive, ...keepalive ? {} : {signal: netSignal(POST_MS)},
      });
    } catch {
      return undefined;
    }
  }
}

let reporter: RumReporter | undefined;

export function startRum(url: string): RumReporter {
  if (!reporter) {
    reporter = new RumReporter({url});
    reporter.start();
  }
  return reporter;
}
