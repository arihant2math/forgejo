// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only actions (PLAN §5.4): merge, branch operations, file edits,
// releases, actions, settings, the classic UI… are never queued. Offline
// they are disabled and say why. `connectivity.online` is observable;
// `ONLINE_ONLY` is the one wording of the reason.

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

/** The explanation shown on an online-only action while offline ("Merging needs a connection: it is not queued offline."). */
export function onlineOnly(action: string): string {
  return `${action} needs a connection: it is not queued offline.`;
}
