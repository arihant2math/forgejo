// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {shortcuts} from '../app/shortcuts/index.ts';
import {LinkRows} from './LinkRows.tsx';
import {ListRow} from './ListRow.tsx';

afterEach(cleanup);

test('J/K walk rows across sections, skipping other links, and Enter opens the focused row', () => {
  const open = vi.fn();
  const detach = shortcuts.attach(window);
  render(<LinkRows>
    <a href="#other">View all</a>
    <section><ListRow role={undefined} href="#first">First</ListRow></section>
    <section><ListRow role={undefined} href="#second" onClick={open}>Second</ListRow></section>
  </LinkRows>);
  try {
    fireEvent.keyDown(document.body, {key: 'j'});
    expect(document.activeElement).toBe(screen.getByText('First').closest('a'));
    fireEvent.keyDown(document.activeElement ?? document.body, {key: 'j'});
    const second = screen.getByText('Second').closest('a');
    expect(document.activeElement).toBe(second);
    expect(second?.hasAttribute('data-active')).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {key: 'k'});
    expect(document.activeElement).toBe(screen.getByText('First').closest('a'));
    expect(second?.hasAttribute('data-active')).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, {key: 'j'});
    fireEvent.keyDown(document.activeElement ?? document.body, {key: 'Enter'});
    expect(open).toHaveBeenCalledOnce();
  } finally {
    detach();
  }
});
