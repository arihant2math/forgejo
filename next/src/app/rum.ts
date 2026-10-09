// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// RUM (PLAN §5.8), the reporting half (loaded when idle after the first
// paint, never on the boot route): batches what sync/rum.ts collected and
// the boot marks of the performance timeline into POST /-/sync/rum reports
// (B8, protocol.RUMReport).
//
// The contract: `marks` maps a known name to one value in ms (0–10 min),
// `events` a known name to a count (0–1000); ≤ 8 KiB; JSON; anonymous;
// 10 reports a minute per client address (burst 10). So:
//
//   * boot marks (ms from `appStart`) go once per page load, in the first
//     report after they happened; a mark after the page was hidden (a tab
//     opened in the background) is not reported, nor a network mark (the
//     socket, catching up) after the device went offline (sync/rum.ts);
//   * mutation and interaction samples go one per mark per report: a flush
//     sends at most MAX_REPORTS reports, and what does not fit waits for the
//     next one (sync/rum.ts keeps a uniform sample per mark);
//   * INP: the worst interaction (Event Timing ≥ 16 ms, by interactionId) of
//     each visible period, reported when the page is hidden;
//   * a flush every FLUSH_MS while something is waiting, and when the page
//     is hidden (all of its reports at once, fetch keepalive); nothing while
//     offline;
//   * the tabs of a browser share one budget (localStorage `forgejo-next:rum`:
//     the times of the reports sent in the last minute, at most TAB_BUDGET),
//     below the server's per-address limit; a 429 waits for its Retry-After,
//     a network error or a 5xx keeps the batch for the next flush, other
//     refusals drop it.
//
// Privacy: only the fixed names and numbers (whole milliseconds); no
// identifiers, URLs, texts or credentials (`credentials: 'omit'`, no
// Authorization header; the document's referrer policy is no-referrer).
//
// The offline queue's depth has no slot in protocol.RUMReport (backend
// follow-up, IMPLEMENTATION.md F8): its largest value per period is put on the
// performance timeline as `rum:queueDepth` (detail = depth), for profiling.

import {
  type RUMEvent, type RUMMark, type RUMReport,
  RUMCaughtUp, RUMDataOpen, RUMFirstPaintFromCache, RUMHydrateAll, RUMHydrateRoute, RUMInteraction, RUMWSOpen,
} from '../protocol/types.gen.ts';
import {disturbedSince, putBack, sample, takeCollected} from '../sync/rum.ts';
import {netSignal} from '../sync/net.ts';

/** Boot marks: the report's name → the performance entry (a mark, or a measure's end), and whether it needs the network. */
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
/** A report not accepted within this time is given up (it holds one of the host's connections; ms). */
const POST_MS = 15_000;
const BUDGET_KEY = 'forgejo-next:rum';

export interface RumEnv {
  /** POST target: sitePath(config, '/-/sync/rum'). */
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The shared budget's storage (localStorage). */
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
    // The boot marks of this load, once the first sync is in.
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

  /** The boot marks not reported yet, in ms from appStart (those a hidden page or the network distorted are left out). */
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

  /** Takes up to `n` slots of the browser-wide budget (reports sent in the last minute by any tab). */
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

  /** Sends what is waiting. `final`: the page is being hidden (the period's INP goes too, all reports at once). */
  async flush(final: boolean): Promise<void> {
    if (final) {
      // Taken now, whatever happens below: it waits in the buffer if it cannot go.
      const v = inp([...this.interactions.values()]);
      if (v !== undefined) sample(RUMInteraction, v);
      this.interactions.clear();
    }
    const now = this.now();
    // A hide sends even while a periodic flush is in flight (its requests are independent, keepalive).
    if ((this.sending && !final) || now < this.blockedUntil || !navigator.onLine) return;
    const got = takeCollected();
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
    // What did not fit the budget, and what did not fit the reports, waits for the next flush.
    back(built.reports.slice(allowed), reports.length === 0);
    putBack(built.rest, new Map<RUMEvent, number>());
    if (reports.length === 0) return;
    const nested = this.sending;
    this.sending = true;
    try {
      // On hide, all at once (only requests started now outlive the page); otherwise one after the other.
      const answers = final ? await Promise.all(reports.map((r) => this.post(r, true))) : [];
      for (const [n, report] of reports.entries()) {
        const res = final ? answers[n] : await this.post(report, false);
        const status = res?.status ?? 0;
        if (status === 0 || status === 429 || status >= 500) {
          // Not taken: kept for later (a 429: after its Retry-After).
          if (status === 429) this.blockedUntil = now + retryAfter(res, now);
          back(final ? [report] : reports.slice(n), n === 0);
          if (!final) break;
          continue;
        }
        // Delivered, or refused for good (another 4xx): either way not sent again.
        if (n === 0) for (const m of boot.keys()) this.bootSent.add(m);
      }
    } finally {
      if (!nested) this.sending = false;
    }
  }

  /** The answer, or undefined when the request did not complete. */
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

/** Starts reporting for this page (once). */
export function startRum(url: string): RumReporter {
  if (!reporter) {
    reporter = new RumReporter({url});
    reporter.start();
  }
  return reporter;
}
