// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {RepositoryConfirmation} from './RepositoryConfirmation.tsx';

const base = {open: true, title: 'Delete alice/notes?', description: 'This cannot be undone.', confirmLabel: 'Delete repository'};

test('destructive operations with a name guard require the exact name again each time', () => {
  const confirm = vi.fn();
  const close = vi.fn();
  const props = {...base, confirmText: 'alice/notes', onConfirm: confirm, onOpenChange: close};
  const view = render(<RepositoryConfirmation {...props}/>);
  expect(screen.getByRole('dialog', {name: base.title})).toBeTruthy();
  const button = screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel});
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', {name: 'Type alice/notes to confirm'}), {target: {value: 'alice/other'}});
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), {target: {value: 'alice/notes'}});
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledOnce();
  view.rerender(<RepositoryConfirmation {...props} open={false}/>);
  view.rerender(<RepositoryConfirmation {...props}/>);
  expect(screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel}).disabled).toBe(true);
});

test('a simple confirmation stays open while busy and does not send duplicate writes', () => {
  const confirm = vi.fn();
  const close = vi.fn();
  const props = {...base, onConfirm: confirm, onOpenChange: close};
  const view = render(<RepositoryConfirmation {...props}/>);
  fireEvent.click(screen.getByRole('button', {name: base.confirmLabel}));
  expect(confirm).toHaveBeenCalledOnce();
  view.rerender(<RepositoryConfirmation {...props} busy/>);
  fireEvent.click(screen.getByRole('button', {name: base.confirmLabel}));
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  view.rerender(<RepositoryConfirmation {...props} error="Forgejo refused"/>);
  expect(screen.getByText('Forgejo refused')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(close).toHaveBeenCalledWith(false);
});
