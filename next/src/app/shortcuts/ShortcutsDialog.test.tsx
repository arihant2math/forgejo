// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ThemeProvider} from '@primer/react';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {expect, test} from 'vitest';
import {AppContext, createApp, type App} from '../store.ts';
import {shortcuts} from './index.ts';
import {ShortcutsDialog} from './ShortcutsDialog.tsx';

const Harness = observer(({app}: {app: App}) => app.ui.shortcutsOpen ? <ShortcutsDialog/> : null);
function setup() {
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, undefined);
  render(<ThemeProvider><AppContext.Provider value={app}><button type="button">Opener</button><Harness app={app}/></AppContext.Provider></ThemeProvider>);
  const opener = screen.getByRole('button', {name: 'Opener'});
  opener.focus();
  act(() => { runInAction(() => { app.ui.shortcutsOpen = true; }); });
  return {app, opener};
}

test('Primer help dialog lists shortcuts by scope, omitting commands without keys', () => {
  setup();
  const dialog = screen.getByRole('dialog', {name: 'Keyboard shortcuts'});
  expect(within(dialog).getByRole('heading', {name: 'General'})).toBeTruthy();
  expect(within(dialog).getByText('Open the command menu')).toBeTruthy();
  expect(within(dialog).getByText('Move the card')).toBeTruthy();
  expect(within(dialog).queryByText('Create new file')).toBeNull();
  expect(dialog.querySelector('kbd[data-component="KeybindingHint"]')).toBeTruthy();
});

test('active scopes come first; shadowed or unbound page bindings are omitted', () => {
  const popIssue = shortcuts.pushScope('issue');
  const popBoard = shortcuts.pushScope('board');
  const offLabels = shortcuts.bind('issue.labels', () => undefined);
  const offRight = shortcuts.bind('board.right', () => undefined);
  try {
    setup();
    const dialog = screen.getByRole('dialog', {name: 'Keyboard shortcuts'});
    expect(within(dialog).getAllByRole('heading', {level: 2})[0]?.textContent).toBe('Boards · on this page');
    expect(within(dialog).queryByText('Labels')).toBeNull();
    expect(within(dialog).queryByText('Change status')).toBeNull();
    expect(within(dialog).getByText('Next column')).toBeTruthy();
    // Local board keys are still listed without registry bindings.
    expect(within(dialog).getByText('Move the cursor')).toBeTruthy();
  } finally {
    offRight(); offLabels(); popBoard(); popIssue();
  }
});

test('Escape and the Close footer dismiss help and restore the opener', async () => {
  const {app, opener} = setup();
  fireEvent.keyDown(screen.getByRole('dialog', {name: 'Keyboard shortcuts'}), {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(opener); });
  expect(app.ui.shortcutsOpen).toBe(false);
  act(() => { runInAction(() => { app.ui.shortcutsOpen = true; }); });
  // The header's icon button is also named Close; target the footer action explicitly.
  const footer = screen.getByRole('dialog').querySelector('[data-component="Dialog.Footer"]');
  if (!(footer instanceof HTMLElement)) throw new Error('Missing Dialog footer');
  fireEvent.click(within(footer).getByRole('button', {name: 'Close', exact: true}));
  await waitFor(() => { expect(document.activeElement).toBe(opener); });
  expect(app.ui.shortcutsOpen).toBe(false);
});
