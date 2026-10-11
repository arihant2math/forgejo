// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ListRow} from './index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Where the popper wrapper sits (jsdom has no layout): left edge and width. */
function placeWrapper(left: number, width: number) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-radix-popper-content-wrapper')) return real.call(this);
    return DOMRect.fromRect({x: left, y: 100, width, height: 200});
  });
}

function openMenu() {
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild><ListRow role="option">Row</ListRow></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem>Unsubscribe and mark read</ContextMenuItem></ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText('Row'), {clientX: 195, clientY: 300});
  return screen.getByRole('menu');
}

// #227: on a 390px phone a 220px menu opened at x=195 fits on neither side of the pointer; Radix left it at
// left=-27 (or running off the right edge).
test('a context menu that would run off the left edge is moved inside the viewport', async () => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
  placeWrapper(-27, 220);
  const menu = openMenu();
  await waitFor(() => {
    expect(menu.style.translate).toBe('35px 0');
  });
});

test('a context menu that would run off the right edge is moved inside the viewport', async () => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
  placeWrapper(197, 220);
  const menu = openMenu();
  // 197 + 220 = 417: 35px past the 8px gap from the right edge (382).
  await waitFor(() => {
    expect(menu.style.translate).toBe('-35px 0');
  });
});

test('a context menu that fits is left where Radix put it', async () => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
  placeWrapper(195, 220);
  const menu = openMenu();
  await waitFor(() => {
    expect(menu.style.translate).toBe('');
  });
});
