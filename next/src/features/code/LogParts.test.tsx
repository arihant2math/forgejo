// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {BaseStyles, ThemeProvider} from '@primer/react';
import {fireEvent, render, screen} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {StepHeader} from './LogParts.tsx';
import {CheckStatus} from './CheckStatus.tsx';

test('a log step remains an accessible disclosure with status and duration', () => {
  const toggle = vi.fn();
  const {rerender} = render(<ThemeProvider><BaseStyles><StepHeader expanded onToggle={toggle} mark={<CheckStatus tone="success"/>} meta="4 s">Build HTML</StepHeader></BaseStyles></ThemeProvider>);
  const button = screen.getByRole('button', {name: /Build HTML/});
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.textContent).toContain('4 s');
  fireEvent.click(button);
  expect(toggle).toHaveBeenCalledOnce();
  rerender(<ThemeProvider><BaseStyles><StepHeader expanded={false} onToggle={toggle} mark={<CheckStatus tone="success"/>} meta="4 s">Build HTML</StepHeader></BaseStyles></ThemeProvider>);
  expect(screen.getByRole('button', {name: /Build HTML/}).getAttribute('aria-expanded')).toBe('false');
});
