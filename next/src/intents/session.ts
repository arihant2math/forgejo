// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One overlay and one intent queue per signed-in session. Started at boot
// (app/boot.ts, its own chunk, in parallel with the route): the stored
// queue is in the overlay before the first frame, so a reload with pending
// changes shows them at once, online or offline. `editing(app)` is how views
// reach them.

import {autorun, runInAction, untracked, when} from 'mobx';
import {sitePath} from '../app/config.ts';
import {dismissSeries, notify} from '../app/notices.ts';
import {reach} from '../app/online.ts';
import type {App, Session} from '../app/store.ts';
import {APIPrefix} from '../protocol/types.gen.ts';
import {type Channel, type IntentMessage, Intents, type Override} from './executor.ts';
import {type Names, withIssue} from './intents.ts';
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
        tone: 'danger', title: `${withIssue(d.title, d.issueNumber)} failed`,
        description: `${d.reason ?? ''} It was undone and kept in Unsynced changes.`.trim(),
        // A refusal would be refused again: no Retry (the Unsynced panel still offers it, with the text).
        action: d.intent && !d.refused ? {label: 'Retry', run: () => {
          intents.retry(d.key);
        }} : {label: 'Review', run: () => {
          openUnsynced(app);
        }},
      });
    },
    onOverride: (o) => {
      // Shown inline on the issue's page (Overrides): no second message when that page is open, and the page
      // takes this notice back when it opens (overrideSeries).
      if (app.ui.issueOpen === o.issueId) return;
      const words = overrideWords(app, o, true);
      notify(app, {
        tone: 'neutral', title: words.title, description: words.description, series: overrideSeries(o.id),
        action: {label: 'Undo', run: () => {
          intents.undoOverride(o.id);
        }},
      });
    },
    onConflict: (rec) => {
      if (app.ui.issueOpen === rec.intent.issueId) return;
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
  // The inbox's unread count as the user sees it (the sidebar is on the boot route and does not load the overlay).
  autorun(() => {
    const base = data.pool.model('Notification').by('status', 'unread').size;
    let n = base;
    for (const [id, status] of overlay.fieldOverrides('Notification', 'status')) {
      const server = data.pool.model('Notification').get(id)?.get('status');
      if (server === undefined) continue;
      if (server === 'unread' && status !== 'unread') n--;
      else if (server !== 'unread' && status === 'unread') n++;
    }
    runInAction(() => {
      app.ui.unread = n;
    });
  });
  // Back in the foreground: what other tabs did while this one slept (bfcache, frozen tabs).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void intents.reread();
  });
  return e;
}

/** The notice of an override, taken back once the issue's page shows it. */
export const overrideSeries = (id: string) => `override:${id}`;

/**
 * The one wording of "your offline change won over a newer one", for the notice and the issue page's callout: who
 * made the newer change (yourself on another device is not "@dev"), and what else happened to the issue meanwhile
 * (closed or reopened by someone).
 */
export function overrideWords(app: App, o: Override, named = false): {title: string; description: string} {
  const s = app.session;
  return untracked(() => {
    const pool = s?.data.pool;
    const issue = pool?.model('Issue').get(o.issueId)?.data;
    const ref = named && issue ? ` of #${String(issue.number)}` : '';
    const self = o.who !== 0 && o.who === s?.userId;
    const login = o.who && !self ? pool?.model('User').get(o.who)?.data.login : undefined;
    const title = `You overrode ${login ? `@${login}’s` : 'a newer'} change to the ${o.field}${ref}`;
    const where = self ? 'It was changed on Forgejo from another device or tab' : 'It changed on Forgejo';
    let also = '';
    if (issue && o.field !== 'status' && o.since !== undefined) {
      const closed = issue.state === 'closed' && issue.closed_at !== undefined && Date.parse(issue.closed_at) > o.since;
      if (closed) also = ' The issue was also closed meanwhile.';
    }
    return {title, description: `${where} while you were offline; your change was applied last.${also}`};
  });
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
    issue: (id: number) => pool.model('Issue').get(id)?.data.number,
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

/**
 * Says that a change was queued while offline (or while Forgejo cannot be reached), and takes the notice back once
 * the change has been sent: "Review queued" no longer stays after the review went out (QA verify3).
 */
export function notifyQueued(app: App, intentId: string, title: string): void {
  if (reach(app.session?.data.status.connection) === 'online') return;
  const series = `queued:${intentId}`;
  notify(app, {tone: 'neutral', title, description: 'It is sent when you are back online.', series});
  when(() => !editing(app).intents.records.has(intentId), () => {
    dismissSeries(app, series);
  });
}
