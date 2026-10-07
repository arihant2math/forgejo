// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import './styles/app.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app/App.tsx';
import {BootFailed} from './app/BootFailed.tsx';
import {loadRoute} from './app/routes.ts';
import {followSystemTheme} from './app/theme.ts';

followSystemTheme();
const root = document.getElementById('root');
// The static boot shell stays on screen until the route module is here; then
// one commit replaces it (no Suspense fallback, see routes.ts).
if (root) {
  loadRoute(location.pathname).then(({default: route}) => {
    try {
      sessionStorage.removeItem('bootRetry');
    } catch {
      // Storage blocked.
    }
    createRoot(root).render(
      <StrictMode>
        <App route={route}/>
      </StrictMode>,
    );
  }, (error: unknown) => {
    // A chunk of an older build (deleted after a deploy) or a network error:
    // reload once to get the current index.html (B8 must serve it with
    // Cache-Control: no-cache). F5's service worker makes this rare.
    console.error('loading the route failed', error);
    let retried = true;
    try {
      retried = sessionStorage.getItem('bootRetry') !== null;
      if (!retried) sessionStorage.setItem('bootRetry', '1');
    } catch {
      // Storage blocked: do not risk a reload loop.
    }
    if (retried) {
      createRoot(root).render(<BootFailed/>);
    } else {
      location.reload();
    }
  });
}
