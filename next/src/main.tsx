// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import './styles/app.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app/App.tsx';
import {BootFailed} from './app/BootFailed.tsx';
import {bootApp} from './app/boot.ts';
import {resumeAfterSignIn} from './app/history.ts';
import {warmViews} from './app/router.tsx';
import {bootSucceeded, reloadOnce} from './app/reload.ts';
import {followSystemTheme} from './app/theme.ts';

resumeAfterSignIn();
followSystemTheme();
const root = document.getElementById('root');
// The static boot shell stays on screen until the route is ready; then one
// commit replaces it (no Suspense fallback, see app/boot.ts).
/** `localStorage.profile = '1'`: this load renders with React's profiling build (app/profile.tsx). */
function profiling(): boolean {
  try {
    return localStorage.getItem('profile') === '1';
  } catch {
    return false;
  }
}

if (root) {
  bootApp().then(({app, router}) => {
    bootSucceeded();
    const tree = (
      <StrictMode>
        <App app={app} router={router}/>
      </StrictMode>
    );
    // localStorage.profile = '1': React's profiling build (app/profile.tsx).
    if (profiling()) void import('./app/profile.tsx').then((m) => m.profiledRoot(root, tree)).catch(() => {
      createRoot(root).render(tree);
    });
    else createRoot(root).render(tree);
    warmViews();
  }, (error: unknown) => {
    // A chunk of an older build (deleted after a deploy), a network error, or
    // local storage that cannot be opened: reload once, then a Reload screen.
    console.error('booting failed', error);
    if (!reloadOnce()) createRoot(root).render(<BootFailed/>);
  });
}
