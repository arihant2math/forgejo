// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import './styles/app.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app/App.tsx';
import {loadRoute} from './app/routes.ts';
import {followSystemTheme} from './app/theme.ts';

followSystemTheme();
const root = document.getElementById('root');
// The static boot shell stays on screen until the route module is here; then
// one commit replaces it (no Suspense fallback, see routes.ts).
if (root) {
  loadRoute(location.pathname).then(({default: route}) => {
    createRoot(root).render(
      <StrictMode>
        <App route={route}/>
      </StrictMode>,
    );
  }, (error: unknown) => {
    console.error('loading the route failed', error);
  });
}
