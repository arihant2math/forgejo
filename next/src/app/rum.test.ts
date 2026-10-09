// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import type {RUMReport} from '../protocol/types.gen.ts';
import {count, MAX_SAMPLES, queueDepth, sample, takeCollected} from '../sync/rum.ts';
import {buildReports, inp, MAX_REPORTS, RumReporter, TAB_BUDGET} from './rum.ts';

// The server's accepted names (routers/livesync/rum.go): anything else is rejected there.
const MARKS = ['firstPaintFromCache', 'dataOpen', 'wsOpen', 'caughtUp', 'hydrateRoute', 'hydrateAll', 'mutationLocal', 'mutationAcked', 'mutationConfirmed', 'inp'];
const EVENTS = ['intentFlushed', 'intentRetried', 'intentFailed', 'conflictMerged', 'conflictOverride', 'conflictDiscarded'];

beforeEach(() => {
  takeCollected();
  performance.clearMarks();
  performance.clearMeasures();
});

describe('collecting', () => {
  test('samples keep a bounded uniform sample per mark; bad values are dropped', () => {
    for (let i = 0; i < 1000; i++) sample('mutationLocal', i);
    sample('mutationAcked', Number.NaN);
    sample('mutationAcked', -1);
    count('intentFlushed');
    count('intentFlushed', 2);
    queueDepth(3);
    queueDepth(1);
    const got = takeCollected();
    expect(got.samples.get('mutationLocal')).toHaveLength(MAX_SAMPLES);
    // Not just the first MAX_SAMPLES: later samples got in.
    expect(Math.max(...got.samples.get('mutationLocal') ?? [])).toBeGreaterThan(MAX_SAMPLES);
    expect(got.samples.has('mutationAcked')).toBe(false);
    expect(got.counts.get('intentFlushed')).toBe(3);
    expect(got.queueMax).toBe(3);
    expect(takeCollected().samples.size).toBe(0);
  });
});

describe('reports', () => {
  test('boot marks and counts go in the first report; one sample per mark per report; the rest waits', () => {
    const boot = new Map([['firstPaintFromCache', 87.25], ['caughtUp', 412]]);
    const samples = new Map([['mutationLocal', [3, 4, 5, 6, 7]], ['mutationAcked', [40]]]);
    const counts = new Map([['intentFlushed', 2], ['conflictMerged', 0]]);
    const {reports, rest} = buildReports(boot, samples, counts);
    expect(reports).toHaveLength(MAX_REPORTS);
    expect(reports[0]).toEqual({marks: {firstPaintFromCache: 87, caughtUp: 412, mutationLocal: 3, mutationAcked: 40}, events: {intentFlushed: 2}});
    expect(reports[1]).toEqual({marks: {mutationLocal: 4}});
    expect(reports[2]).toEqual({marks: {mutationLocal: 5}});
    expect([...rest]).toEqual([['mutationLocal', [6, 7]]]);
  });

  test('values out of the contract\'s range are not sent; nothing to say ⇒ no report', () => {
    const {reports} = buildReports(new Map([['wsOpen', -3]]), new Map([['mutationAcked', [11 * 60_000]]]), new Map());
    expect(reports).toEqual([]);
  });

  test('INP: the worst interaction, one skipped per 50', () => {
    expect(inp([])).toBeUndefined();
    expect(inp([10, 200, 40])).toBe(200);
    expect(inp([...Array.from({length: 60}, () => 10), 500, 300])).toBe(300);
  });
});

describe('reporter', () => {
  let posted: {url: string; init: RequestInit}[];
  let status: number;
  let headers: Record<string, string>;
  const fetchFake = (async (url: string, init: RequestInit) => {
    posted.push({url, init});
    return Promise.resolve(new Response(null, {status, headers}));
  }) as unknown as typeof fetch;
  /** A fresh browser-wide budget per test (the tabs' shared localStorage). */
  const memory = () => {
    const m = new Map<string, string>();
    return {getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v)};
  };

  beforeEach(() => {
    posted = [];
    status = 204;
    headers = {};
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const bodies = () => posted.map((p) => JSON.parse(p.init.body as string) as RUMReport);

  test('posts anonymous JSON with only the contract\'s names and numbers; boot marks once per page', async () => {
    performance.mark('appStart');
    performance.mark('firstPaintFromCache');
    performance.mark('wsOpen');
    performance.measure('hydrate:route', {start: 0, end: performance.now()});
    sample('mutationLocal', 4);
    count('conflictOverride');
    const r = new RumReporter({url: '/sub/-/sync/rum', fetch: fetchFake, storage: memory()});
    await r.flush(false);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('/sub/-/sync/rum');
    const init = posted[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toEqual({'Content-Type': 'application/json'});
    const [body] = bodies();
    expect(Object.keys(body?.marks ?? {}).sort()).toEqual(['firstPaintFromCache', 'hydrateRoute', 'mutationLocal', 'wsOpen']);
    expect(body?.events).toEqual({conflictOverride: 1});
    for (const b of bodies()) {
      for (const [k, v] of Object.entries(b.marks ?? {})) {
        expect(MARKS).toContain(k);
        expect(typeof v).toBe('number');
      }
      for (const k of Object.keys(b.events ?? {})) expect(EVENTS).toContain(k);
      expect(JSON.stringify(b).length).toBeLessThan(8 << 10);
    }
    // The boot marks are not sent again; the caught-up mark that came later is.
    performance.mark('caughtUp');
    await r.flush(false);
    expect(Object.keys(bodies()[1]?.marks ?? {})).toEqual(['caughtUp']);
    await r.flush(false);
    expect(posted).toHaveLength(2);
  });

  test('a 429 keeps everything for later and waits for its Retry-After; a network failure or a 5xx keeps it too', async () => {
    vi.useFakeTimers({now: 1_000_000, toFake: ['Date']});
    status = 429;
    headers = {'Retry-After': '61'};
    sample('mutationAcked', 50);
    count('intentRetried', 2);
    const r = new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage: memory()});
    await r.flush(false);
    expect(posted).toHaveLength(1);
    status = 204;
    await r.flush(false);
    expect(posted).toHaveLength(1); // still blocked
    vi.setSystemTime(1_000_000 + 60_000);
    await r.flush(false);
    expect(posted).toHaveLength(1); // Retry-After 61 s
    vi.setSystemTime(1_000_000 + 62_000);
    await r.flush(false);
    expect(bodies()[1]).toEqual({marks: {mutationAcked: 50}, events: {intentRetried: 2}});
    const failing = new RumReporter({url: '/-/sync/rum', fetch: () => Promise.reject(new TypeError('offline')), storage: memory()});
    sample('mutationLocal', 3);
    await failing.flush(false);
    expect(takeCollected().samples.get('mutationLocal')).toEqual([3]);
    status = 503;
    const restarting = new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage: memory()});
    sample('mutationLocal', 5);
    count('intentFailed');
    await restarting.flush(false);
    const kept = takeCollected();
    expect(kept.samples.get('mutationLocal')).toEqual([5]);
    expect(kept.counts.get('intentFailed')).toBe(1);
  });

  test('the tabs of a browser share one budget of reports a minute', async () => {
    vi.useFakeTimers({now: 2_000_000, toFake: ['Date']});
    const storage = memory();
    const tabs = [0, 1, 2].map(() => new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage}));
    for (const tab of tabs) {
      for (let i = 0; i < 9; i++) sample('mutationLocal', i);
      await tab.flush(false);
    }
    expect(posted).toHaveLength(TAB_BUDGET);
    // The rest waits, and goes once the minute has passed.
    vi.setSystemTime(2_000_000 + 61_000);
    await tabs[0]?.flush(false);
    expect(posted.length).toBeGreaterThan(TAB_BUDGET);
  });

  test('network marks after the device went offline are not reported; local ones are (an offline warm boot)', async () => {
    performance.mark('appStart');
    performance.mark('firstPaintFromCache');
    dispatchEvent(new Event('offline'));
    performance.mark('wsOpen');
    const r = new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage: memory()});
    await r.flush(false);
    expect(Object.keys(bodies()[0]?.marks ?? {})).toEqual(['firstPaintFromCache']);
  });

  test('boot marks of a page hidden while booting are not reported', async () => {
    performance.mark('appStart');
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
    performance.mark('firstPaintFromCache');
    const r = new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage: memory()});
    sample('mutationLocal', 2);
    await r.flush(false);
    expect(bodies()[0]).toEqual({marks: {mutationLocal: 2}});
  });

  test('the final flush (page hidden) reports the period\'s INP with keepalive, all reports at once', async () => {
    const r = new RumReporter({url: '/-/sync/rum', fetch: fetchFake, storage: memory()});
    (r as unknown as {interactions: Map<number, number>}).interactions.set(1, 120).set(2, 48);
    for (const ms of [1, 2, 3]) sample('mutationAcked', ms);
    await r.flush(true);
    expect(bodies()).toHaveLength(3);
    expect(bodies()[0]).toEqual({marks: {inp: 120, mutationAcked: 1}});
    expect(posted.every((p) => p.init.keepalive)).toBe(true);
  });
});
