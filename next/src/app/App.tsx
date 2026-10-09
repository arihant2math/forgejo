// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {RouterProvider} from '@tanstack/react-router';
import type {AppRouter} from './router.tsx';
import {type App as AppState, AppContext} from './store.ts';

/** The app root: the app state and the router (which renders the route's view). */
export function App({app, router}: {app: AppState; router: AppRouter}) {
  return (
    <AppContext value={app}>
      <RouterProvider router={router}/>
    </AppContext>
  );
}
