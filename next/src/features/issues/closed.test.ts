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

  test('a page that fails (summary not loaded yet) is tried again later, then given up', async () => {
    vi.useFakeTimers();
    try {
      const {data, calls} = fakeData([new Error('not loaded yet'), {next: undefined, count: 3}]);
      const p = closedPager(data, 'repo:902');
      p.more();
      await vi.advanceTimersByTimeAsync(2100);
      expect(calls).toHaveLength(2);
      expect(p.done).toBe(true);
      expect(p.count).toBe(3);
      const failing = fakeData(Array.from({length: 12}, () => new Error('down')));
      const q = closedPager(failing.data, 'repo:903');
      q.more();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(failing.calls).toHaveLength(10);
      expect(q.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
