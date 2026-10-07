// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, test} from 'vitest';
import {App} from './App.tsx';
import {BootShell} from './BootShell.tsx';
import {classConflicts} from '../test/conflicts.ts';
import {SKELETON_MAX_ROWS} from './splash.ts';

afterEach(() => {
  localStorage.clear();
});

describe('boot', () => {
  test('the static boot shell has the full set of skeleton rows (the splash script hides extras)', () => {
    const html = renderToStaticMarkup(<BootShell/>);
    expect(html.match(/data-sk-row=""/g)).toHaveLength(SKELETON_MAX_ROWS);
    expect(html).toContain('logged-out:flex');
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(classConflicts(div)).toEqual([]);
  });

  test('the boot route renders (lazy chunk) for a logged-out device', async () => {
    render(<App pathname={import.meta.env.BASE_URL}/>);
    expect(await screen.findByRole('button', {name: 'Sign in'})).toBeTruthy();
  });

  test('the gallery route is available in dev', async () => {
    render(<App pathname={`${import.meta.env.BASE_URL}gallery`}/>);
    expect(await screen.findByRole('heading', {name: 'Primitives'})).toBeTruthy();
    // The gallery renders every primitive and variant: none may set a property twice.
    expect(classConflicts(document.body)).toEqual([]);
  });
});
