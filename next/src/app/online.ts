// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only actions are never queued; offline controls share the same disabled reason.

import {observable, runInAction} from 'mobx';

export const connectivity = observable({online: typeof navigator === 'undefined' ? true : navigator.onLine});

if (typeof window !== 'undefined') {
  const update = () => {
    runInAction(() => {
      connectivity.online = navigator.onLine;
    });
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}

export function onlineOnly(action: string): string {
  return `${action} needs a connection: it is not queued offline.`;
}

/** Distinguishes browser/sync offline from an online browser with an unresponsive server; observes connectivity. */
export function reach(connection: string | undefined): 'online' | 'offline' | 'unreachable' {
  if (!connectivity.online || connection === 'offline') return 'offline';
  return connection === 'unreachable' ? 'unreachable' : 'online';
}
