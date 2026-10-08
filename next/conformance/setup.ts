// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Runs after ../integration/setup.ts (the Node stubs of `window` and
// `localStorage` the app's data layer needs, shared with F2's integration
// project): a run without a server fails with instructions instead of
// passing empty.

import {env} from './env.ts';

if (!env.url) {
  throw new Error('FORGEJO_URL is not set: run the suite through `next/tools/dev-forgejo.sh conformance [pg|mysql|all]`, '
    + 'or point FORGEJO_URL at a Forgejo with [livesync] ENABLED = true (see next/conformance/env.ts)');
}
