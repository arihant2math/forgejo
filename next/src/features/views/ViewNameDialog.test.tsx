// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles, ThemeProvider} from '@primer/react';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {ViewNameDialog} from './ViewNameDialog.tsx';

test('view naming validates whitespace and saves trimmed names with keyboard submission', () => {
  const save = vi.fn();
  const close = vi.fn();
  render(<ThemeProvider><BaseStyles><ViewNameDialog title="Save the view" onSave={save} onClose={close}/></BaseStyles></ThemeProvider>);
  const dialog = screen.getByRole('dialog', {name: 'Save the view'});
  const input = within(dialog).getByRole('textbox', {name: /^View name/});
  const submit = within(dialog).getByRole<HTMLButtonElement>('button', {name: 'Save'});
  expect(input.getAttribute('maxlength')).toBe('80');
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, {target: {value: '   '}});
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, {target: {value: '  Needs triage  '}});
  expect(submit.disabled).toBe(false);
  const form = input.closest('form');
  if (!form) throw new Error('No view naming form');
  fireEvent.submit(form);
  expect(save).toHaveBeenCalledExactlyOnceWith('Needs triage');
  expect(close).toHaveBeenCalledOnce();
});

test('submitting an unchanged view name closes without updating it', () => {
  const save = vi.fn();
  const close = vi.fn();
  render(<ThemeProvider><BaseStyles><ViewNameDialog title="Rename the view" initial="Triage" onSave={save} onClose={close}/></BaseStyles></ThemeProvider>);
  fireEvent.keyDown(screen.getByRole('textbox', {name: 'View name'}), {key: 'Enter'});
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

test('renaming starts with the current name and cancellation makes no changes', () => {
  const save = vi.fn();
  const close = vi.fn();
  render(<ThemeProvider><BaseStyles><ViewNameDialog title="Rename the view" initial="Triage" onSave={save} onClose={close}/></BaseStyles></ThemeProvider>);
  const input = screen.getByRole<HTMLInputElement>('textbox', {name: /^View name/});
  expect(input.value).toBe('Triage');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe('Triage'.length);
  fireEvent.change(input, {target: {value: 'Triage 2'}});
  fireEvent.keyDown(input, {key: 'Enter', isComposing: true});
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
