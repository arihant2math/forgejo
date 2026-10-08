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
import {sitePath, uiPath} from './config.ts';
import {hasUser, readSplash} from './splash.ts';
import type {App, Session} from './store.ts';

const LEADER_RETRY = 'forgejo-next:leaderRetry';

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
  // The leader's modules, fetched while IndexedDB is read (data.ts loads them lazily).
  void import('../sync/client.ts').catch(() => undefined);
  const data = await openData({
    userId, auth, endpoint: sitePath(config, '/-/sync'), ...(config.version ? {buildId: config.version} : {}),
    onFatal: (err) => {
      // The sync modules of this build are gone (a deploy) or unreachable: reload, at most once a
      // minute (boot itself succeeds without them, so the boot retry guard does not apply).
      console.error('livesync: this tab cannot sync', err);
      try {
        const last = Number(sessionStorage.getItem(LEADER_RETRY) ?? 0);
        if (Date.now() - last < 60_000) return;
        sessionStorage.setItem(LEADER_RETRY, String(Date.now()));
      } catch {
        return;
      }
      location.reload();
    },
  });
  await data.firstRoute;
  return {userId, auth, data};
}

/** This tab is signing out: its own `logout` broadcast (heard by followOtherTabs' channel) must not reload it midway. */
let signingOut = false;

/** Sign out now (no warning); then the logged-out screen. */
export async function performSignOut(app: App): Promise<void> {
  const s = app.session;
  if (!s || signingOut) return;
  signingOut = true;
  await signOut({
    auth: s.auth, close: () => s.data.close(),
    // Forgejo's classic sign-out (same-origin POST passes its cross-origin protection).
    endWebSession: async () => {
      await fetch(sitePath(app.config, '/user/logout'), {
        method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(3000),
      });
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

/**
 * Turns the opt-in cookie off and opens this page in the classic UI (the UI's
 * own pages have no classic counterpart: the dashboard then).
 */
export function switchToClassic(app: App): void {
  const here = `${location.pathname}${location.search}`;
  const back = location.pathname.startsWith(app.config.base) ? sitePath(app.config, '/') : here;
  location.assign(`${uiPath(app.config, 'opt-out')}?redirect=${encodeURIComponent(back)}`);
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
      if (signingOut) return;
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
