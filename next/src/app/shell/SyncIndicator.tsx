// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Observe only connection/auth fields so data deltas and position updates do not re-render the indicator.

import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {DotFillIcon} from '@primer/octicons-react';
import {signInHere} from '../session.ts';
import {useApp, useSession} from '../store.ts';
import {Button, Tooltip} from '@primer/react';

interface View {
  tone: 'muted' | 'warning' | 'success';
  label: string;
  detail: string;
  signIn?: boolean;
  retry?: boolean;
}

/** `ready` means the workspace is loaded; a caught-up session alone must not be shown as Live. */
export function describe(connection: string, loading: number, auth: string, ready = true): View {
  if (auth === 'expired' || connection === 'unauthorized') {
    return {tone: 'warning', label: 'Signed out', detail: 'Your session ended. Changes wait here until you sign in again.', signIn: true};
  }
  if (connection === 'offline') return {tone: 'muted', label: 'Offline', detail: 'Showing what is on this device. Changes sync when you are back online.'};
  if (connection === 'unreachable') {
    return {tone: 'warning', label: 'Can’t reach Forgejo', detail: 'Forgejo is not answering. Showing what is on this device; changes sync once it is back.', retry: true};
  }
  if (connection === 'live' && loading === 0 && ready) return {tone: 'success', label: 'Live', detail: 'Up to date. Changes from others appear as they happen.'};
  if (connection === 'live' || connection === 'catching_up') return {tone: 'muted', label: 'Catching up', detail: 'Loading what changed while you were away.'};
  if (auth === 'offline') return {tone: 'muted', label: 'Offline', detail: 'Forgejo cannot be reached. Showing what is on this device.'};
  return {tone: 'muted', label: 'Connecting', detail: 'Connecting to Forgejo…'};
}

export const SyncIndicator = observer(function SyncIndicator() {
  const app = useApp();
  const {data, auth} = useSession();
  const v = describe(data.status.connection, data.status.loading, auth.status.state, data.workspace.current !== undefined);
  const pending = app.ui.pendingIntents;
  // Keep the same button so count updates cannot move focus.
  const open = () => {
    runInAction(() => {
      app.ui.unsyncedOpen = true;
    });
  };
  const words = pending > 0 ? `${v.label} · ${String(pending)} pending` : v.label;
  const quiet = v.tone === 'success' && pending === 0;
  return (
    <div className="flex items-center gap-2" data-sync-indicator="">
      {!quiet && <Tooltip text={pending ? `${v.detail} ${String(pending)} not synced yet: see them.` : v.detail}>
        <Button variant="invisible" size="small" onClick={open} aria-label={`${words}: show unsynced changes`} leadingVisual={() => <DotFillIcon className={v.tone === 'success' ? 'text-success' : v.tone === 'warning' ? 'text-attention' : 'text-muted'}/>} >
          {v.label}
          {pending > 0 && <span className="tabular-nums">· {pending} pending</span>}
        </Button>
      </Tooltip>}
      {/* Announce connection changes, not every pending-count update. */}
      <span role="status" className="sr-only">{v.label}</span>
      {v.retry && (
        <Button variant="invisible" size="small" type="button" onClick={() => {
          data.retry();
        }}>Retry now</Button>
      )}
      {v.signIn && app.config.oauth && (
        <Button variant="primary" size="small" type="button" onClick={() => {
          signInHere(app);
        }}>Sign in</Button>
      )}
    </div>
  );
});
