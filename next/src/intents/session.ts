// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One overlay and one intent executor per signed-in session, created when a
// view that edits first needs them (they are not on the boot route).

import {untracked} from 'mobx';
import {sitePath} from '../app/config.ts';
import {notify} from '../app/notices.ts';
import type {App, Session} from '../app/store.ts';
import {Intents} from './executor.ts';
import {describeIntent, type Intent, type IntentInput} from './intents.ts';
import {Overlay} from './overlay.ts';

export interface Editing {
  overlay: Overlay;
  intents: Intents;
}

const sessions = new WeakMap<Session, Editing>();

/** The session's overlay and intents. */
export function editing(app: App): Editing {
  const s = app.session;
  if (!s) throw new Error('editing without a session');
  let e = sessions.get(s);
  if (!e) {
    const overlay = new Overlay();
    const intents: Intents = new Intents({
      pool: s.data.pool,
      overlay,
      whenSynced: (g, v) => s.data.whenSynced(g, v),
      token: () => s.auth.token(),
      refresh: () => s.auth.refresh(),
      apiBase: sitePath(app.config, '/api/v1'),
      online: () => navigator.onLine,
      onRejected: (i, r) => {
        const what = describeIntent(i, names(s));
        notify(app, {
          tone: 'danger',
          title: `${what} failed`,
          description: `${r.message} The change was undone.`,
          ...(r.reason === 'offline' ? {} : {action: {label: 'Retry', run: () => {
            intents.submit(retryOf(i));
          }}}),
        });
      },
    });
    e = {overlay, intents};
    sessions.set(s, e);
  }
  return e;
}

function names(s: Session) {
  const pool = s.data.pool;
  return untracked(() => ({
    label: (id: number) => pool.model('Label').get(id)?.data.name ?? '',
    user: (id: number) => pool.model('User').get(id)?.data.login ?? '',
    milestone: (id: number) => pool.model('Milestone').get(id)?.data.title ?? '',
  }));
}

/** The same change as a new intent (a new Idempotency-Key: the old one's answer is stored). */
function retryOf(i: Intent): IntentInput {
  const {id: _id, key: _key, created: _created, ...input} = i;
  return input;
}
