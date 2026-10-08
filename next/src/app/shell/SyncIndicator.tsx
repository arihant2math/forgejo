// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The global sync indicator (PLAN §5.4): live / catching up / offline,
// with the number of intents waiting to sync. An observer leaf: it reads the
// connection fields of the sync status and the auth state, nothing else, so
// deltas and position updates do not re-render it.

import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {Button, Status, type StatusTone, Tooltip} from '../../ui/index.ts';
import {signInHere} from '../session.ts';
import {useApp, useSession} from '../store.ts';

interface View {
  tone: StatusTone;
  label: string;
  detail: string;
  signIn?: boolean;
}

export function describe(connection: string, loading: number, auth: string): View {
  if (auth === 'expired' || connection === 'unauthorized') {
    return {tone: 'warning', label: 'Signed out', detail: 'Your session ended. Changes wait here until you sign in again.', signIn: true};
  }
  if (connection === 'offline') return {tone: 'muted', label: 'Offline', detail: 'Showing what is on this device. Changes sync when you are back online.'};
  if (connection === 'live' && loading === 0) return {tone: 'success', label: 'Live', detail: 'Up to date. Changes from others appear as they happen.'};
  if (connection === 'live' || connection === 'catching_up') return {tone: 'muted', label: 'Catching up', detail: 'Loading what changed while you were away.'};
  if (auth === 'offline') return {tone: 'muted', label: 'Offline', detail: 'Forgejo cannot be reached. Showing what is on this device.'};
  return {tone: 'muted', label: 'Connecting', detail: 'Connecting to Forgejo…'};
}

export const SyncIndicator = observer(function SyncIndicator() {
  const app = useApp();
  const {data, auth} = useSession();
  const v = describe(data.status.connection, data.status.loading, auth.status.state);
  const pending = app.ui.pendingIntents;
  // With changes waiting it opens the "Unsynced changes" panel (its own chunk).
  const open = pending > 0 ? () => {
    runInAction(() => {
      app.ui.unsyncedOpen = true;
    });
  } : undefined;
  return (
    <div className="flex items-center gap-2">
      <Tooltip content={pending ? `${v.detail} ${String(pending)} not synced yet: see them.` : v.detail}>
        <span role="status">
          <Status tone={v.tone} onClick={open} label={pending ? `${v.label}, ${String(pending)} pending: show unsynced changes` : undefined}>
            {v.label}
            {pending > 0 && <span className="tabular-nums">· {pending} pending</span>}
          </Status>
        </span>
      </Tooltip>
      {v.signIn && app.config.oauth && (
        <Button size="sm" variant="primary" onClick={() => {
          signInHere(app);
        }}>Sign in</Button>
      )}
    </div>
  );
});
