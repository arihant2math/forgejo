// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction} from 'mobx';
import {AUTH_CHANNEL, type AuthMessage, AuthSession} from '../auth/session.ts';
import {resumeWipes, signOut} from '../auth/signout.ts';
import {endWebSession, resumeWebLogout} from '../auth/weblogout.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import {openData} from '../sync/data.ts';
import {sitePath} from './config.ts';
import {hasUser, readSplash} from './splash.ts';
import type {App, Session} from './store.ts';

const LEADER_RETRY = 'forgejo-next:leaderRetry';

/** Opens the local user's data from IndexedDB before networking; token refresh runs in the background. */
export async function openSession(config: NextConfig): Promise<Session | undefined> {
  const splash = readSplash();
  const userId = hasUser(splash) ? Number(splash.user) : NaN;
  resumeWipes(Number.isSafeInteger(userId) ? userId : undefined);
  resumeWebLogout();
  if (!Number.isSafeInteger(userId) || userId <= 0) return undefined;
  const auth = new AuthSession(config.oauth, userId);
  // Fetch leader modules in parallel with IndexedDB.
  void import('../sync/client.ts').catch(() => undefined);
  const data = await openData({
    userId, auth, endpoint: sitePath(config, '/-/sync'), ...(config.version ? {buildId: config.version} : {}),
    onFatal: (err) => {
      // Boot can succeed without sync modules, so use a separate one-minute reload guard.
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

/** Suppresses reload from this tab's own logout broadcast until sign-out finishes. */
let signingOut = false;

/** Signs out without an unsynced-intent warning. */
export async function performSignOut(app: App): Promise<void> {
  const s = app.session;
  if (!s || signingOut) return;
  signingOut = true;
  await signOut({
    auth: s.auth, close: () => s.data.close(),
    // Same-origin POST satisfies classic sign-out's protection; weblogout retries offline failures.
    endWebSession: () => endWebSession(sitePath(app.config, '/user/logout')),
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
  void import('../auth/signin.ts').then((m) => m.startSignIn(app.config, `${location.pathname}${location.search}`)).catch((err: unknown) => {
    console.error('sign-in failed to start', err);
  });
}

/** Reloads for other tabs' sign-in/out broadcasts; returns a listener cleanup function. */
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
