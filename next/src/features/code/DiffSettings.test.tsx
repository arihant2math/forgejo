// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {beforeEach, expect, test, vi} from 'vitest';
import {useDiffSettings} from './DiffSettings.tsx';

vi.mock('../../app/store.ts', () => ({useSession: () => ({userId: 7})}));
vi.mock('@tanstack/react-router', () => ({useLocation: () => ''}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

function Settings() {
  const s = useDiffSettings();
  return <button onClick={() => {s.set(false, false);}}>{s.split ? 'split' : 'unified'}:{s.hide ? 'hide' : 'show'}</button>;
}

test('legacy diff preferences persist as JSON after editing', () => {
  localStorage.setItem('forgejo-next:diff:7', 'split:hide');
  render(<Settings/>);
  fireEvent.click(screen.getByRole('button', {name: 'split:hide'}));
  expect(screen.getByRole('button', {name: 'unified:show'})).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('forgejo-next:diff:7') ?? 'null')).toBe('unified:show');
});

test('invalid diff preferences fall back and URL whitespace takes precedence', () => {
  localStorage.setItem('forgejo-next:diff:7', 'broken');
  window.history.replaceState(null, '', '/?w=1');
  render(<Settings/>);
  fireEvent.click(screen.getByRole('button', {name: 'unified:hide'}));
  expect(screen.getByRole('button', {name: 'unified:show'})).toBeTruthy();
  expect(window.location.search).toBe('');
});
