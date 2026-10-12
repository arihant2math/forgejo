// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {BaseStyles, ThemeProvider} from '@primer/react';
import {expect, test, vi} from 'vitest';
import {fallbackConfig} from '../config.ts';
import {AppContext, createApp} from '../store.ts';
import {fakeSession} from '../../test/fakeSession.ts';
import {SignOutDialog} from './Overlays.tsx';

const signOut = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)));
vi.mock('../session.ts', () => ({performSignOut: signOut}));

test('signing out with unsynced changes asks first: Cancel has focus, the confirmation shows it is working and runs once', async () => {
  const app = createApp(fallbackConfig(), fakeSession());
  app.ui.signOut = {pending: 2};
  render(<AppContext value={app}><ThemeProvider><BaseStyles><SignOutDialog pending={2}/></BaseStyles></ThemeProvider></AppContext>);
  const dialog = screen.getByRole('alertdialog', {name: 'Sign out with unsynced changes?'});
  expect(dialog.textContent).toContain('2 changes have not reached Forgejo yet.');
  await waitFor(() => { expect(document.activeElement).toBe(within(dialog).getByRole('button', {name: 'Cancel'})); });
  const confirm = within(dialog).getByRole('button', {name: 'Sign out anyway'});
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(signOut).toHaveBeenCalledOnce();
  await waitFor(() => { expect(confirm.getAttribute('data-loading')).toBe('true'); });
});
