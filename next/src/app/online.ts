// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only actions are never queued; offline controls share the same disabled reason.

import {observable, reaction, runInAction} from 'mobx';
import {useSyncExternalStore} from 'react';
import {useApp} from './store.ts';

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

/** reach() of the current session as React state: hooks re-render on changes even outside observer components. */
export function useReach(): 'online' | 'offline' | 'unreachable' {
  const app = useApp();
  const read = () => reach(app.session?.data.status.connection);
  return useSyncExternalStore((changed) => reaction(read, changed), read);
}

/** Why an online-only action cannot run now (for a disabled control's tooltip or note), or undefined when it can. */
export function useOfflineReason(action: string): string | undefined {
  return useReach() === 'online' ? undefined : onlineOnly(action);
}
