// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {FormControl, TextInput} from '@primer/react';
import {ConfirmByName} from './ConfirmByName.tsx';

const base = {open: true, title: 'Delete alice/notes?', description: 'This cannot be undone.', confirmLabel: 'Delete repository'};

test('destructive operations with a name guard require the exact name again each time', () => {
  const confirm = vi.fn();
  const close = vi.fn();
  const props = {...base, confirmText: 'alice/notes', onConfirm: confirm, onOpenChange: close};
  const view = render(<ConfirmByName {...props}/>);
  expect(screen.getByRole('dialog', {name: base.title})).toBeTruthy();
  const button = screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel});
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', {name: 'Type alice/notes to confirm'}), {target: {value: 'alice/other'}});
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), {target: {value: 'alice/notes'}});
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledOnce();
  view.rerender(<ConfirmByName {...props} open={false}/>);
  view.rerender(<ConfirmByName {...props}/>);
  expect(screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel}).disabled).toBe(true);
});

test('a simple confirmation stays open while busy and does not send duplicate writes', () => {
  const confirm = vi.fn();
  const close = vi.fn();
  const props = {...base, onConfirm: confirm, onOpenChange: close};
  const view = render(<ConfirmByName {...props}/>);
  fireEvent.click(screen.getByRole('button', {name: base.confirmLabel}));
  expect(confirm).toHaveBeenCalledOnce();
  view.rerender(<ConfirmByName {...props} busy/>);
  fireEvent.click(screen.getByRole('button', {name: base.confirmLabel}));
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  view.rerender(<ConfirmByName {...props} error="Forgejo refused"/>);
  expect(screen.getByText('Forgejo refused')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(close).toHaveBeenCalledWith(false);
});

test('the name field has focus, and Enter confirms only once the name matches', async () => {
  const confirm = vi.fn();
  render(<ConfirmByName {...base} confirmText="alice/notes" onConfirm={confirm} onOpenChange={vi.fn()}/>);
  const field = screen.getByRole('textbox', {name: 'Type alice/notes to confirm'});
  await waitFor(() => { expect(document.activeElement).toBe(field); });
  fireEvent.keyDown(field, {key: 'Enter'});
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(field, {target: {value: 'alice/notes'}});
  fireEvent.keyDown(field, {key: 'Enter'});
  expect(confirm).toHaveBeenCalledOnce();
});

test('a simple danger confirmation is Primer\'s, focusing Cancel first', async () => {
  render(<ConfirmByName {...base} onConfirm={vi.fn()} onOpenChange={vi.fn()}/>);
  const dialog = screen.getByRole('alertdialog', {name: base.title});
  await waitFor(() => { expect(document.activeElement).toBe(within(dialog).getByRole('button', {name: 'Cancel'})); });
});

test('the first field has focus: a field of the extra content comes before the name', async () => {
  render(<ConfirmByName {...base} confirmText="alice/notes" onConfirm={vi.fn()} onOpenChange={vi.fn()}>
    <FormControl><FormControl.Label>New owner</FormControl.Label><TextInput/></FormControl>
  </ConfirmByName>);
  const owner = screen.getByRole('textbox', {name: 'New owner'});
  await waitFor(() => { expect(document.activeElement).toBe(owner); });
});

test('while busy the name field keeps focus, and the confirm button too', async () => {
  const props = {...base, confirmText: 'alice/notes', onConfirm: vi.fn(), onOpenChange: vi.fn()};
  const view = render(<ConfirmByName {...props}/>);
  const field = screen.getByRole<HTMLInputElement>('textbox', {name: 'Type alice/notes to confirm'});
  await waitFor(() => { expect(document.activeElement).toBe(field); });
  fireEvent.change(field, {target: {value: 'alice/notes'}});
  view.rerender(<ConfirmByName {...props} busy/>);
  expect(document.activeElement).toBe(field);
  expect(field.readOnly).toBe(true);
  const button = screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel});
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button);
  fireEvent.keyDown(field, {key: 'Enter'});
  expect(props.onConfirm).not.toHaveBeenCalled();
});

test('a blocked confirmation says why and does not confirm, also without a name to type', () => {
  const confirm = vi.fn();
  const view = render(<ConfirmByName {...base} blocked="Deleting needs a connection." onConfirm={confirm} onOpenChange={vi.fn()}/>);
  expect(screen.getByText('Deleting needs a connection.')).toBeTruthy();
  const button = screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel});
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  view.rerender(<ConfirmByName {...base} confirmText="alice/notes" blocked="Deleting needs a connection." onConfirm={confirm} onOpenChange={vi.fn()}/>);
  const field = screen.getByRole('textbox', {name: 'Type alice/notes to confirm'});
  fireEvent.change(field, {target: {value: 'alice/notes'}});
  fireEvent.keyDown(field, {key: 'Enter'});
  expect(screen.getByRole<HTMLButtonElement>('button', {name: base.confirmLabel}).disabled).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
});
