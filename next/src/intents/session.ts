// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One overlay and one intent queue per signed-in session. Started at boot
// (app/boot.ts, its own chunk, in parallel with the route): the stored
// queue is in the overlay before the first frame, so a reload with pending
// changes shows them at once, online or offline. `editing(app)` is how views
// reach them.

import {autorun, runInAction, untracked} from 'mobx';
import {sitePath} from '../app/config.ts';
import {notify} from '../app/notices.ts';
import type {App, Session} from '../app/store.ts';
import {APIPrefix} from '../protocol/types.gen.ts';
import {type Channel, type IntentMessage, Intents} from './executor.ts';
import type {Names} from './intents.ts';
import {Overlay} from './overlay.ts';
import {IntentDb} from './store.ts';

export interface Editing {
  overlay: Overlay;
  intents: Intents;
}

const sessions = new WeakMap<Session, Editing>();

/** Starts the session's queue (idempotent); resolves once the stored intents are in the overlay. */
export async function startEditing(app: App): Promise<Editing> {
  const e = editing(app);
  await e.intents.ready.catch((err: unknown) => {
    console.error('intents: reading the queue failed', err);
  });
  return e;
}

/** The session's overlay and intents. */
export function editing(app: App): Editing {
  const s = app.session;
  if (!s) throw new Error('editing without a session');
  let e = sessions.get(s);
  if (e) return e;
  const overlay = new Overlay();
  const {data, auth} = s;
  const intents = new Intents({
    pool: data.pool,
    overlay,
    userId: s.userId,
    db: new IntentDb(data.db),
    channel: broadcast(`forgejo-next:${String(s.userId)}:intents`),
    isLeader: () => data.role.leader,
    connection: () => data.status.connection,
    onCaughtUp: (fn) => data.on('caughtUp', fn),
    onRevoked: (fn) => data.on('revoked', ({group}) => {
      fn(group);
    }),
    onIssueDropped: (fn) => data.on('issueDropped', ({issueId}) => {
      fn(issueId);
    }),
    whenSynced: (g, v, signal) => data.whenSynced(g, v, signal),
    barrier: () => data.barrier(),
    token: () => auth.token(),
    refresh: () => auth.refresh(),
    apiBase: sitePath(app.config, '/api/v1'),
    syncApiBase: sitePath(app.config, APIPrefix),
    online: () => navigator.onLine,
    names: () => names(s),
    onFailed: (d) => {
      notify(app, {
        tone: 'danger', title: `${d.title} failed`,
        description: `${d.reason ?? ''} It was undone and kept in Unsynced changes.`.trim(),
        action: d.intent ? {label: 'Retry', run: () => {
          intents.retry(d.key);
        }} : {label: 'Review', run: () => {
          openUnsynced(app);
        }},
      });
    },
    onOverride: (o) => {
      const who = o.who ? untracked(() => data.pool.model('User').get(o.who)?.data.login) : undefined;
      notify(app, {
        tone: 'neutral', title: `You overrode ${who ? `@${who}’s` : 'a newer'} change`,
        description: `The ${o.field} was changed while you were offline; your change won.`,
        action: {label: 'Undo', run: () => {
          intents.undoOverride(o.id);
        }},
      });
    },
    onConflict: () => {
      notify(app, {
        tone: 'warning', title: 'Your edit conflicts with a newer change',
        description: 'Both changed the same lines. Resolve it in the editor; nothing is lost.',
        action: {label: 'Review', run: () => {
          openUnsynced(app);
        }},
      });
    },
  });
  e = {overlay, intents};
  sessions.set(s, e);
  // The sync indicator's "N pending" and the sign-out warning.
  autorun(() => {
    const n = intents.pending + intents.failedCount;
    runInAction(() => {
      app.ui.pendingIntents = n;
    });
  });
  // Back in the foreground: what other tabs did while this one slept (bfcache, frozen tabs).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void intents.reread();
  });
  return e;
}

/** Opens the "Unsynced changes" panel. */
export function openUnsynced(app: App): void {
  runInAction(() => {
    app.ui.unsyncedOpen = true;
  });
}

function names(s: Session): Names {
  const pool = s.data.pool;
  return untracked(() => ({
    label: (id: number) => pool.model('Label').get(id)?.data.name ?? '',
    user: (id: number) => pool.model('User').get(id)?.data.login ?? '',
    milestone: (id: number) => pool.model('Milestone').get(id)?.data.title ?? '',
  }));
}

/** The tabs' channel for queue messages (none without BroadcastChannel: each tab then leads alone, F2). */
function broadcast(name: string): Channel {
  const BC = globalThis.BroadcastChannel as typeof BroadcastChannel | undefined;
  const ch = BC ? new BC(name) : undefined;
  const handlers = new Set<(m: IntentMessage) => void>();
  if (ch) ch.onmessage = (ev: MessageEvent<IntentMessage>) => {
    for (const h of handlers) h(ev.data);
  };
  return {
    post(m) {
      try {
        ch?.postMessage(m);
      } catch (err) {
        console.error('intents: broadcast failed', err);
      }
    },
    onMessage(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    close() {
      ch?.close();
    },
  };
}
