// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {expect, test} from 'vitest';
import {ListRow} from './ListRow.tsx';

test('a row with an href is a link, one without is a plain row', () => {
  render(<>
    <ListRow href="/dev/fzf" leading={<span>icon</span>} trailing={<span>2 days ago</span>}>fzf</ListRow>
    <ListRow>Loading</ListRow>
  </>);
  const link = screen.getByRole('link', {name: /fzf/});
  expect(link.getAttribute('href')).toBe('/dev/fzf');
  expect(link.hasAttribute('data-list-row')).toBe(true);
  const plain = screen.getByText('Loading').parentElement;
  expect(plain?.tagName).toBe('DIV');
  expect(plain?.hasAttribute('href')).toBe(false);
});

test('options report selection; the cursor and the selection have their own tones', () => {
  render(<div role="listbox" aria-label="Results">
    <ListRow role="option" active>cursor</ListRow>
    <ListRow role="option" active selected>both</ListRow>
    <ListRow role="option">neither</ListRow>
  </div>);
  const [cursor, both, neither] = screen.getAllByRole('option');
  expect(cursor?.getAttribute('aria-selected')).toBe('false');
  expect(cursor?.hasAttribute('data-active')).toBe(true);
  expect(both?.getAttribute('aria-selected')).toBe('true');
  expect(both?.hasAttribute('data-selected')).toBe(true);
  expect(neither?.hasAttribute('data-active')).toBe(false);
  // A listbox that tracks its cursor as the selection says so itself.
  render(<ListRow role="option" active aria-selected>own</ListRow>);
  expect(screen.getByRole('option', {name: 'own'}).getAttribute('aria-selected')).toBe('true');
});

test('compact rows use the fixed row height, normal rows pad a line', () => {
  render(<>
    <ListRow density="compact" href="/dev/fzf/src/branch/main/README.md">README.md</ListRow>
    <ListRow href="/dev/fzf">fzf</ListRow>
  </>);
  const compact = screen.getByRole('link', {name: 'README.md'});
  expect(compact.classList.contains('h-row')).toBe(true);
  expect(compact.classList.contains('py-2')).toBe(false);
  const normal = screen.getByRole('link', {name: 'fzf'});
  expect(normal.classList.contains('py-2')).toBe(true);
  expect(normal.classList.contains('h-row')).toBe(false);
});
