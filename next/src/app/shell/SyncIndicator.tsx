// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The global sync indicator (PLAN §5.4): catching up / offline / signed
// out, with the number of intents waiting to sync (and of those Forgejo
// refused). Live with nothing waiting or refused
// is the normal state and shows nothing (the live region still announces
// it). An observer leaf: it reads the connection fields of the sync status
// and the auth state, nothing else, so deltas and position updates do not
// re-render it.

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
  /** Forgejo cannot be reached: offer to try again now. */
  retry?: boolean;
}

/**
 * `ready`: the viewer's workspace is known (fetched once on this device). A new device is never "Live" before
 * that: the session may be caught up while nothing is loaded yet.
 */
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
  // Refused changes are not "pending" next to a green Live (QA): they are said apart, in the warning tone.
  const failed = app.ui.failedIntents;
  // Opens the "Unsynced changes" panel (its own chunk). Always the same button: focus stays when the count changes.
  const open = () => {
    runInAction(() => {
      app.ui.unsyncedOpen = true;
    });
  };
  const parts = [pending > 0 && `${String(pending)} pending`, failed > 0 && `${String(failed)} not sent`].filter(Boolean);
  const words = [v.label, ...parts].join(' · ');
  const tip = [v.detail, pending > 0 && `${String(pending)} not synced yet.`, failed > 0 && `${String(failed)} refused by Forgejo: retry or discard.`].filter(Boolean).join(' ');
  // Up to date and nothing waiting or refused: no badge, only the live region (the header stays quiet, like GitHub's).
  const quiet = v.tone === 'success' && pending === 0 && failed === 0;
  return (
    <div className="flex items-center gap-2" data-sync-indicator="">
      {!quiet && <Tooltip content={tip}>
        <Status tone={failed > 0 && v.tone === 'success' ? 'warning' : v.tone} onClick={open} label={`${words}: show unsynced changes`}>
          {v.label}
          {pending > 0 && <span className="tabular-nums">· {pending} pending</span>}
          {failed > 0 && <span className="tabular-nums">· {failed} not sent</span>}
        </Status>
      </Tooltip>}
      {/* The live region: announces the connection, apart from the button (not every pending change). */}
      <span role="status" className="sr-only">{v.label}</span>
      {v.retry && (
        <Button size="sm" variant="ghost" onClick={() => {
          data.retry();
        }}>Retry now</Button>
      )}
      {v.signIn && app.config.oauth && (
        <Button size="sm" variant="primary" onClick={() => {
          signInHere(app);
        }}>Sign in</Button>
      )}
    </div>
  );
});
