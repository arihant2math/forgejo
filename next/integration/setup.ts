// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Stub browser globals used by the data layer while retaining Node's real network APIs.

const store = new Map<string, string>();
const localStorageStub: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => {
    store.set(k, v);
  },
  removeItem: (k) => {
    store.delete(k);
  },
};
const target = new EventTarget();
Object.assign(globalThis, {
  localStorage: localStorageStub,
  window: {addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target)},
});
