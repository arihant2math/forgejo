// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {connectivity} from '../../app/online.ts';
import {AppContext, createApp} from '../../app/store.ts';
import {fakeSession} from '../../test/fakeSession.ts';
import {LabelDialog} from './LabelDialog.tsx';

afterEach(() => { runInAction(() => { connectivity.online = true; }); });

function show(onSave = vi.fn().mockResolvedValue(true)) {
  const onClose = vi.fn();
  const app = createApp(fallbackConfig(), fakeSession());
  render(<AppContext.Provider value={app}><LabelDialog repo={{owner: 'acme', name: 'site', id: 20}} count={0} onClose={onClose} onSave={onSave}/></AppContext.Provider>);
  return {onSave, onClose};
}

test('label form validates, previews preset colours and saves its normalized draft', async () => {
  const {onSave, onClose} = show();
  fireEvent.click(screen.getByRole('button', {name: 'Create label'}));
  expect(screen.getByText('A label needs a name.')).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', {name: 'Name'}), {target: {value: 'kind/bug'}});
  fireEvent.change(screen.getByRole('textbox', {name: 'Colour'}), {target: {value: 'not-hex'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create label'}));
  expect(onSave).not.toHaveBeenCalled();
  const preset = screen.getByRole('button', {name: '#e11d21'});
  fireEvent.click(preset);
  expect(preset.getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByRole('textbox', {name: 'Colour'}) as HTMLInputElement).value).toBe('#e11d21');
  fireEvent.click(screen.getByRole('button', {name: 'Create label'}));
  await waitFor(() => { expect(onClose).toHaveBeenCalledOnce(); });
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({name: 'kind/bug', color: '#e11d21'}));
});

test('offline label creation remains visible with its reason, but does not save', () => {
  runInAction(() => { connectivity.online = false; });
  const {onSave} = show();
  fireEvent.change(screen.getByRole('textbox', {name: 'Name'}), {target: {value: 'triage'}});
  const save = screen.getByRole<HTMLButtonElement>('button', {name: 'Create label'});
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/Saving a label/);
  fireEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
});
