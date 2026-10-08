// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import type {ActionRunJob, LogClosedMessage, LogMessage} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';
import {LogFeed} from './logfeed.ts';
import type {CodeSource} from './source.ts';

const job = {id: 9, task_id: 3, status: 'running', name: 'build'} as ActionRunJob;
const line = (c: string) => ({t: 0, c});

/** A Data whose tailLog delivers `script` synchronously to every new subscriber (the worst case for re-entrancy). */
function fakeData(script: (LogMessage | LogClosedMessage)[]) {
  const asks: unknown[] = [];
  let subs = 0;
  const data = {
    tailLog: (jobId: number, from: unknown, fn: (m: LogMessage | LogClosedMessage) => void) => {
      asks.push(from);
      if (++subs > 50) throw new Error('re-subscribed in a loop');
      for (const m of script) fn(m);
      return () => undefined;
    },
  } as unknown as Data;
  return {data, asks};
}

const src = {cache: {put: vi.fn(), get: () => Promise.resolve(undefined)}} as unknown as CodeSource;

test('a gap re-tails once, later, from the lines held (no loop inside the callback)', async () => {
  vi.useFakeTimers();
  // An earlier tail's message (offset 5) reaches a fresh feed: a gap, then the restarted tail from 0.
  const {data, asks} = fakeData([{type: 'log', job_id: 9, task_id: 3, offset: 5, lines: [line('f')]}]);
  const feed = new LogFeed(data, src, 1, job);
  const stop = feed.start(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(asks).toEqual([undefined]);
  await vi.advanceTimersByTimeAsync(300);
  // One re-tail per pending gap (the scripted gap repeats on each subscribe: one per 250 ms at most).
  expect(asks.length).toBeLessThanOrEqual(3);
  stop();
  feed.close();
  vi.useRealTimers();
});

test('lines merge; a closed tail is reported', async () => {
  const {data} = fakeData([
    {type: 'log', job_id: 9, task_id: 3, offset: 0, lines: [line('a'), line('b')]},
    {type: 'log', job_id: 9, task_id: 3, offset: 1, lines: [line('b'), line('c')]},
    {type: 'log_closed', job_id: 9, reason: 'limit'},
  ]);
  const feed = new LogFeed(data, src, 1, job);
  const stop = feed.start(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(feed.log.lines.map((l) => l.c)).toEqual(['a', 'b', 'c']);
  expect(feed.closed).toBe('limit');
  stop();
  feed.close();
});
