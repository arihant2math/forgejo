// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import type {Highlight} from '../workers/highlight.ts';
import {Highlighter, type HighlightWorker, LIMITS, Superseded, TimedOut, type WorkerApi} from './highlighter.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const HL: Highlight = {spans: Uint32Array.of(7, 1), starts: Uint32Array.of(0, 1)};

/** A fake worker: `highlight` takes `ms` (virtual), reporting progress every `every` ms (0: never). */
function fakeWorker(log: string[], {ms = 100, every = 0, prepareMs = 0} = {}): HighlightWorker & {stopped: boolean} {
  let fail: (err: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);
  let progress: (() => void) | undefined;
  const w = {
    stopped: false,
    failed,
    stop() {
      w.stopped = true;
      fail(new Error('stopped'));
    },
    onProgress(fn: (() => void) | undefined) {
      progress = fn;
    },
    api: {
      prepare: () => new Promise<void>((resolve) => setTimeout(resolve, prepareMs)),
      highlight: (text: string) => new Promise<Highlight | null>((resolve) => {
        log.push(text);
        let t = 0;
        const tick = () => {
          if (w.stopped) return;
          t += every;
          if (t >= ms) {
            resolve(HL);
            return;
          }
          progress?.();
          setTimeout(tick, every);
        };
        if (every) setTimeout(tick, every);
        else setTimeout(() => {
          resolve(HL);
        }, ms);
      }),
      highlightDiffFile: () => Promise.resolve(null),
    } as unknown as WorkerApi,
  };
  return w;
}

test('a long highlight that makes progress is not stopped (a whole file on a slow device)', async () => {
  const log: string[] = [];
  const workers: ReturnType<typeof fakeWorker>[] = [];
  // 60 s of work: three times the old limit on the whole highlight (at most 20 s), with a chunk done every 2 s.
  const h = new Highlighter(() => {
    const w = fakeWorker(log, {ms: 60_000, every: 2000});
    workers.push(w);
    return w;
  });
  const p = h.highlight('typescript', (api) => api.highlight('const a = 1', 'typescript'));
  await vi.advanceTimersByTimeAsync(61_000);
  await expect(p).resolves.toBe(HL);
  expect(workers).toHaveLength(1);
  expect(workers[0]?.stopped).toBe(false);
});

test('a highlight without progress is stopped; the next one starts a new worker', async () => {
  const log: string[] = [];
  const workers: ReturnType<typeof fakeWorker>[] = [];
  let n = 0;
  const h = new Highlighter(() => {
    // The first runs away (no progress for a minute), the second is quick.
    const w = fakeWorker(log, n++ === 0 ? {ms: 60_000} : {ms: 50});
    workers.push(w);
    return w;
  });
  const stuck = h.highlight('go', (api) => api.highlight('stuck', 'go'));
  const next = h.highlight('go', (api) => api.highlight('next', 'go'));
  const caught = stuck.catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(LIMITS.stall + 10);
  expect(await caught).toBeInstanceOf(TimedOut);
  expect(workers[0]?.stopped).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  await expect(next).resolves.toBe(HL);
  expect(workers).toHaveLength(2);
});

test('starting Shiki and loading a grammar is not timed as the highlight', async () => {
  const log: string[] = [];
  const h = new Highlighter(() => fakeWorker(log, {ms: 100, prepareMs: LIMITS.stall + 5000}));
  const p = h.highlight('rust', (api) => api.highlight('fn main() {}', 'rust'));
  await vi.advanceTimersByTimeAsync(LIMITS.stall + 5200);
  await expect(p).resolves.toBe(HL);
});

test('intents wait for what is on screen, newest first; only the last few wait', async () => {
  const log: string[] = [];
  const h = new Highlighter(() => fakeWorker(log, {ms: 100}));
  const run = (text: string, priority: 'now' | 'idle', key?: string) =>
    h.highlight('go', (api) => api.highlight(text, 'go'), key === undefined ? {priority} : {priority, key});
  const first = run('on screen', 'now');
  const idle = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((t) => run(t, 'idle', t).catch((err: unknown) => err));
  const later = run('on screen too', 'now');
  await vi.advanceTimersByTimeAsync(2000);
  await first;
  await later;
  // The two oldest intents were dropped; the rest ran after the screen's highlights, newest first.
  expect(await idle[0]).toBeInstanceOf(Superseded);
  expect(await idle[1]).toBeInstanceOf(Superseded);
  expect(log).toEqual(['on screen', 'on screen too', 'i6', 'i5', 'i4', 'i3']);
});

test('a view asking for a waiting intent promotes it, also before it is queued', async () => {
  const log: string[] = [];
  const h = new Highlighter(() => fakeWorker(log, {ms: 100}));
  const run = (text: string, priority: 'now' | 'idle') => h.highlight('go', (api) => api.highlight(text, 'go'), {priority, key: text});
  void run('busy', 'now');
  void run('a', 'idle');
  void run('b', 'idle');
  // The view opens "a": it runs before the newer intent "b".
  h.promote('a');
  // "c" is promoted before its job is queued (the view's cache lookup came first).
  h.promote('c');
  void run('c', 'idle');
  await vi.advanceTimersByTimeAsync(1000);
  expect(log).toEqual(['busy', 'a', 'c', 'b']);
});

test('close stops the worker and fails what waits', async () => {
  const log: string[] = [];
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const h = new Highlighter(() => {
    const w = fakeWorker(log, {ms: 100});
    workers.push(w);
    return w;
  });
  const a = h.highlight('go', (api) => api.highlight('a', 'go')).catch((err: unknown) => err);
  const b = h.highlight('go', (api) => api.highlight('b', 'go')).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(0);
  h.close();
  expect(workers[0]?.stopped).toBe(true);
  expect(await a).toBeInstanceOf(Error);
  expect(await b).toBeInstanceOf(Error);
  await expect(h.highlight('go', (api) => api.highlight('c', 'go'))).rejects.toThrow();
});
