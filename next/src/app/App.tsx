// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles} from '@primer/react';
import {ThemeProvider} from '@primer/react/next';
import {RouterProvider} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {AppRouter} from './router.tsx';
import {type App as AppState, AppContext} from './store.ts';
import {themeState} from './theme.ts';

/**
 * Primer's theme context: the colour mode follows the app's preference. The attributes Primer's CSS keys on
 * (data-color-mode, …) are on <html>, set before paint by the splash script and app/theme.ts, so the provider
 * only supplies context (portals, overlays and `useTheme` read it).
 */
export const PrimerTheme = observer(function PrimerTheme({children}: {children: ReactNode}) {
  const pref = themeState.preference;
  return (
    <ThemeProvider colorMode={pref === 'system' ? 'auto' : pref} dayScheme="light" nightScheme="dark" contextOnly>
      <BaseStyles className="h-full">{children}</BaseStyles>
    </ThemeProvider>
  );
});

/** The app root: the app state and the router (which renders the route's view). */
export function App({app, router}: {app: AppState; router: AppRouter}) {
  return (
    <AppContext value={app}>
      <PrimerTheme>
        <RouterProvider router={router}/>
      </PrimerTheme>
    </AppContext>
  );
}
