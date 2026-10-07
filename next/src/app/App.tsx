// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ComponentType} from 'react';

/** The app root. F3 adds the providers (router, store, tooltips) here. */
export function App({route: Route}: {route: ComponentType}) {
  return <Route/>;
}
