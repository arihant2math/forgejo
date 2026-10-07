// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, test} from 'vitest';
import {classConflicts} from '../test/conflicts.ts';
import {App} from './App.tsx';
import {BootShell} from './BootShell.tsx';
import {loadRoute} from './routes.ts';
import {SKELETON_MAX_ROWS} from './splash.ts';

afterEach(() => {
  localStorage.clear();
});

async function renderRoute(path: string) {
  const {default: route} = await loadRoute(`${import.meta.env.BASE_URL}${path}`);
  return render(<App route={route}/>);
}

describe('boot', () => {
  test('the static boot shell has the full set of skeleton rows (the splash script hides extras)', () => {
    const html = renderToStaticMarkup(<BootShell/>);
    expect(html.match(/data-sk-row=""/g)).toHaveLength(SKELETON_MAX_ROWS);
    expect(html).toContain('logged-out:flex');
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(classConflicts(div)).toEqual([]);
  });

  test('the logged-out boot shell is exactly what the boot route renders (wrapper included)', async () => {
    const shell = document.createElement('div');
    shell.innerHTML = renderToStaticMarkup(<BootShell/>);
    const {container} = await renderRoute('');
    const panel = shell.querySelector('.logged-out\\:flex');
    // The boot copy is hidden unless the splash says logged-out; otherwise identical.
    expect(panel?.outerHTML.replace('hidden logged-out:flex', 'flex')).toBe(container.firstElementChild?.outerHTML);
  });

  test('the boot route renders without Suspense (logged-out device)', async () => {
    await renderRoute('');
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
  });

  test('unknown paths fall back to the boot route', async () => {
    await renderRoute('no/such/page');
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
  });

  test('the gallery route is available in dev', async () => {
    await renderRoute('gallery');
    expect(screen.getByRole('heading', {name: 'Primitives'})).toBeTruthy();
    // The gallery renders every primitive and variant: none may set a property twice.
    expect(classConflicts(document.body)).toEqual([]);
  });
});
