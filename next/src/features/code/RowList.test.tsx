// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {act, fireEvent, render, screen} from '@testing-library/react';
import {RouterProvider, createMemoryHistory, createRootRoute, createRouter} from '@tanstack/react-router';
import {useState} from 'react';
import {expect, test, vi} from 'vitest';
import {INTENT_DELAY, RowList} from './RowList.tsx';

function List({onIntent}: {onIntent: (name: string) => void}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller}>
      <RowList items={['a', 'b', 'c']} scroller={scroller} label="Files" keyOf={(s) => s} row={(s) => ({main: s})} onOpen={() => undefined} onIntent={onIntent}/>
    </div>
  );
}

test('only a row the pointer settles on is prefetched', async () => {
  const onIntent = vi.fn();
  // jsdom has no layout; the virtualizer measures offsetHeight for its viewport.
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
  const router = createRouter({routeTree: createRootRoute({component: () => <List onIntent={onIntent}/>}), history: createMemoryHistory()});
  render(<RouterProvider router={router}/>);
  const rows = await screen.findAllByRole('option');
  vi.useFakeTimers();
  try {
    for (const row of rows) {
      fireEvent.pointerEnter(row);
      act(() => { vi.advanceTimersByTime(INTENT_DELAY / 2); });
      fireEvent.pointerLeave(row);
    }
    act(() => { vi.advanceTimersByTime(INTENT_DELAY * 2); });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.pointerEnter(rows[1] as HTMLElement);
    act(() => { vi.advanceTimersByTime(INTENT_DELAY); });
    expect(onIntent).toHaveBeenCalledExactlyOnceWith('b');
  } finally {
    vi.useRealTimers();
    height.mockRestore();
  }
});
