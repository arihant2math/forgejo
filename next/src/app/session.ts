// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Session lifecycle in the running app: opening the signed-in user's data at
// boot, signing out (with the unsynced-intents warning), and reacting to the
// other tabs signing in or out.

import {runInAction} from 'mobx';
import {AUTH_CHANNEL, type AuthMessage, AuthSession} from '../auth/session.ts';
import {resumeWipes, signOut} from '../auth/signout.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import {openData} from '../sync/data.ts';
import {sitePath} from './config.ts';
import {hasUser, readSplash} from './splash.ts';
import type {App, Session} from './store.ts';

/**
 * The session of the user whose data is on this device (splash `user`),
 * rendered from IndexedDB before any network (PLAN §5.2): the data layer is
 * open and the first route's groups are in the pool when this resolves. The
 * token is refreshed in the background, by the sync client's first request.
 */
export async function openSession(config: NextConfig): Promise<Session | undefined> {
  const splash = readSplash();
  const userId = hasUser(splash) ? Number(splash.user) : NaN;
  resumeWipes(Number.isSafeInteger(userId) ? userId : undefined);
  if (!Number.isSafeInteger(userId) || userId <= 0) return undefined;
  const auth = new AuthSession(config.oauth, userId);
  const data = await openData({
    userId, auth, endpoint: sitePath(config, '/-/sync'), ...(config.version ? {buildId: config.version} : {}),
  });
  await data.firstRoute;
  return {userId, auth, data};
}

/** Sign out now (no warning); then the logged-out screen. */
export async function performSignOut(app: App): Promise<void> {
  const s = app.session;
  if (!s) return;
  await signOut({
    auth: s.auth, close: () => s.data.close(),
    // Forgejo's classic sign-out (same-origin POST passes its cross-origin protection).
    endWebSession: async () => {
      await fetch(sitePath(app.config, '/user/logout'), {method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store'});
    },
  });
  location.replace(app.config.base);
}

/** The "Sign out" action: warns first when intents have not synced. */
export async function requestSignOut(app: App): Promise<void> {
  const s = app.session;
  if (!s) return;
  const pending = await s.data.countIntents().catch(() => 0);
  if (pending > 0) {
    runInAction(() => {
      app.ui.signOut = {pending};
    });
    return;
  }
  await performSignOut(app);
}

/** Signs in again (session expired) or for the first time, coming back to this page. */
export function signInHere(app: App): void {
  // The sign-in code is only needed now (its own chunk).
  void import('../auth/signin.ts').then((m) => m.startSignIn(app.config, `${location.pathname}${location.search}`)).catch((err: unknown) => {
    console.error('sign-in failed to start', err);
  });
}

/**
 * Follows the other tabs: a sign-out of this user (or a sign-in of another
 * one) reloads this tab into the right state; a sign-in of this user after
 * the session expired restarts the sync client (a reload: render-first makes
 * it cheap). Returns the function that stops listening.
 */
export function followOtherTabs(app: App): () => void {
  const s = app.session;
  const BC = globalThis.BroadcastChannel as typeof BroadcastChannel | undefined;
  if (!BC) return () => undefined;
  const ch = new BC(AUTH_CHANNEL);
  ch.onmessage = (ev: MessageEvent<AuthMessage>) => {
    const m = ev.data;
    if (!s) {
      if (m.t === 'login') location.reload();
      return;
    }
    if (m.t === 'logout' && m.userId === s.userId) {
      s.auth.close();
      void s.data.close().finally(() => {
        location.replace(app.config.base);
      });
    } else if (m.t === 'login' && m.userId !== s.userId) {
      location.reload();
    } else if (m.t === 'login' && s.data.status.connection === 'unauthorized') {
      location.reload();
    }
  };
  return () => {
    ch.close();
  };
}
