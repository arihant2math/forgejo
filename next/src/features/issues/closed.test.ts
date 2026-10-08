// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test, vi} from 'vitest';
import type {Data} from '../../sync/data.ts';
import {closedPager} from './closed.ts';

function fakeData(pages: ({next: string | undefined; count: number} | Error)[]) {
  const calls: (string | undefined)[] = [];
  const data = {
    loadClosedPage: vi.fn((_group: string, before?: string) => {
      calls.push(before);
      const p = pages.shift();
      return p instanceof Error || !p ? Promise.reject(p ?? new Error('no page')) : Promise.resolve(p);
    }),
  } as unknown as Data;
  return {data, calls};
}

describe('closed tier pager', () => {
  test('pages from the summary cutoff down to the oldest, one at a time', async () => {
    const {data, calls} = fakeData([{next: '100.5', count: 500}, {next: undefined, count: 20}]);
    const p = closedPager(data, 'repo:901');
    p.more();
    p.more(); // a page is loading: no second request
    expect(p.loading).toBe(true);
    await vi.waitFor(() => {
      expect(p.pages).toBe(1);
    });
    p.more();
    await vi.waitFor(() => {
      expect(p.done).toBe(true);
    });
    expect(calls).toEqual([undefined, '100.5']);
    expect(p.count).toBe(520);
    p.more();
    expect(calls).toHaveLength(2);
    expect(closedPager(data, 'repo:901')).toBe(p); // one pager per group
  });

  test('a page that fails (the summary is not loaded yet) is tried again with a backoff, never given up', async () => {
    vi.useFakeTimers();
    try {
      const {data, calls} = fakeData([new Error('not loaded yet'), new Error('not loaded yet'), {next: undefined, count: 3}]);
      const p = closedPager(data, 'repo:902');
      // Callers ask as often as they like (an effect re-running on every change): one request at a time.
      for (let i = 0; i < 10; i++) p.more();
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 10; i++) p.more();
      expect(calls).toHaveLength(1);
      expect(p.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2100);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4100);
      expect(calls).toHaveLength(3);
      expect(p.done).toBe(true);
      expect(p.count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
