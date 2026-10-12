// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import './styles/app.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App, PrimerTheme} from './app/App.tsx';
import {BootFailed} from './app/BootFailed.tsx';
import {bootApp} from './app/boot.ts';
import {ensureLiveRegion} from './app/liveRegion.ts';
import {resumeAfterSignIn} from './app/history.ts';
import {warmViews} from './app/router.tsx';
import {bootSucceeded, reloadOnce} from './app/reload.ts';
import {followSystemTheme} from './app/theme.ts';

resumeAfterSignIn();
followSystemTheme();
ensureLiveRegion();
const root = document.getElementById('root');
/** Enables React's profiling build for this load when localStorage.profile = '1'. */
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
    if (profiling()) void import('./app/profile.tsx').then((m) => m.profiledRoot(root, tree)).catch(() => {
      createRoot(root).render(tree);
    });
    else createRoot(root).render(tree);
    warmViews();
  }, (error: unknown) => {
    // Reload once for boot failure; repeated failure must not loop.
    console.error('booting failed', error);
    if (!reloadOnce()) createRoot(root).render(<PrimerTheme><BootFailed/></PrimerTheme>);
  });
}
