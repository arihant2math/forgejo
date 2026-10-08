// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {env} from './env.ts';

if (!env.url) {
  throw new Error('FORGEJO_URL is not set: run the suite through `next/tools/dev-forgejo.sh conformance [pg|mysql|all]`, '
    + 'or point FORGEJO_URL at a Forgejo with [livesync] ENABLED = true (see next/conformance/env.ts)');
}

// The app's data layer (6-client.test.ts) touches `window` and
// `localStorage`, which Node lacks.
const store = new Map<string, string>();
const target = new EventTarget();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  },
  window: {addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target)},
});
