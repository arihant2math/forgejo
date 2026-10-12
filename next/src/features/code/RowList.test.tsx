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

const day = (s: string) => `Day ${s.slice(0, 1)}`;

function Grouped({onOpen}: {onOpen: (name: string) => void}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller}>
      <RowList items={['1a', '1b', '2a']} scroller={scroller} label="Commits" keyOf={(s) => s} row={(s) => ({main: s})} onOpen={onOpen} groupOf={day}/>
    </div>
  );
}

test('grouped rows get a header per run of the same group, and the cursor moves over items only', async () => {
  const onOpen = vi.fn();
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
  try {
    const router = createRouter({routeTree: createRootRoute({component: () => <Grouped onOpen={onOpen}/>}), history: createMemoryHistory()});
    render(<RouterProvider router={router}/>);
    const list = await screen.findByRole('listbox', {name: 'Commits'});
    expect([...list.children].map((c) => c.textContent)).toEqual(['Day 1', '1a', '1b', 'Day 2', '2a']);
    // The first key shows the cursor on the first item.
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list, {key: 'ArrowDown'});
    fireEvent.keyDown(list, {key: 'Enter'});
    expect(onOpen).toHaveBeenLastCalledWith('2a');
  } finally {
    height.mockRestore();
  }
});
