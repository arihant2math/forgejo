// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Signing in (PLAN §4.9): the authorization code flow with PKCE against
// Forgejo's built-in provider. The classic login and consent pages do the
// talking; {base}callback receives `code` and `state`.
//
// The verifier and state live in sessionStorage (this tab only, gone with
// it) for the round trip, and are removed by the first callback that reads
// them: a code can be exchanged once, by the tab that asked for it.

import {SIGNIN_FROM} from '../app/history.ts';
import {forgetUser, readSplash, writeSplash} from '../app/splash.ts';
import {isLocalPath, redirectUri, sitePath, uiPath} from '../app/config.ts';
import type {NextConfig} from '../protocol/types.gen.ts';
import {exchangeCode, onThisOrigin} from './oauth.ts';
import {optIn} from './optin.ts';
import {challenge, randomToken} from './pkce.ts';
import {AuthSession, type AuthEnv} from './session.ts';
import {deleteToken} from './tokens.ts';
import {unlistWipe} from './wipes.ts';

const PENDING = 'forgejo-next:signin';
/** A sign-in round trip older than this is refused. */
const MAX_AGE = 15 * 60_000;

interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  at: number;
}

/** A local path to come back to after signing in (never the callback itself). */
function returnable(config: NextConfig, path: string): boolean {
  return isLocalPath(config, path) && !path.startsWith(uiPath(config, 'callback'));
}

/** Starts signing in: navigates to Forgejo's authorization page. `returnTo`: a local path to come back to. */
export async function startSignIn(config: NextConfig, returnTo: string, nav: (url: string) => void = (u) => {
  location.assign(u);
}): Promise<void> {
  const oauth = config.oauth;
  const redirect = redirectUri(config);
  if (!oauth || !redirect) throw new Error('signing in is not available');
  const pending: Pending = {
    state: randomToken(16), verifier: randomToken(32), redirectUri: redirect,
    returnTo: returnable(config, returnTo) ? returnTo : sitePath(config, '/'), at: Date.now(),
  };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  // The callback steps back over the sign-in pages from here (app/history.ts).
  sessionStorage.setItem(SIGNIN_FROM, String(history.length));
  const url = new URL(onThisOrigin(oauth.authorize_url));
  url.search = new URLSearchParams({
    response_type: 'code', client_id: oauth.client_id, redirect_uri: redirect, scope: oauth.scope, state: pending.state,
    code_challenge: await challenge(pending.verifier), code_challenge_method: 'S256',
  }).toString();
  nav(url.href);
}

function takePending(): Pending | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    const p = raw ? JSON.parse(raw) as Partial<Pending> : undefined;
    if (typeof p?.state !== 'string' || typeof p.verifier !== 'string' || typeof p.redirectUri !== 'string' ||
      typeof p.returnTo !== 'string' || typeof p.at !== 'number') return undefined;
    return p as Pending;
  } catch {
    return undefined;
  }
}

export type SignInResult =
  | {ok: true; userId: number; returnTo: string}
  | {ok: false; error: string; returnTo: string};

export interface SignInEnv extends AuthEnv {
  /** Deletes the database of a user who signed out implicitly (another user signed in); see completeSignIn. */
  dropUser?: (userId: number) => Promise<void>;
}

interface ApiUser {
  id?: unknown;
  login?: unknown;
}

/**
 * Completes a sign-in on the callback page: checks `state`, exchanges the
 * code, finds out who signed in, stores the refresh token and the local DB
 * marker, opts this browser in to the Next UI on canonical URLs, and tells
 * the other tabs.
 */
export async function completeSignIn(config: NextConfig, search: string, env: SignInEnv = {}): Promise<SignInResult> {
  const params = new URLSearchParams(search);
  const pending = takePending();
  const home = sitePath(config, '/');
  const returnTo = pending && returnable(config, pending.returnTo) ? pending.returnTo : home;
  const fail = (error: string): SignInResult => ({ok: false, error, returnTo});
  const oauth = config.oauth;
  if (!oauth) return fail('Signing in is not available on this server.');
  const error = params.get('error');
  if (error) return fail(error === 'access_denied' ? 'Access was denied.' : `Forgejo refused the sign-in (${error}).`);
  const code = params.get('code');
  const state = params.get('state');
  if (!pending || !code || !state || state !== pending.state || Date.now() - pending.at > MAX_AGE) {
    return fail('This sign-in link is not valid any more.');
  }
  const fetchFn = env.fetch ?? fetch.bind(globalThis);
  const grant = await exchangeCode(oauth, code, pending.verifier, pending.redirectUri, fetchFn);
  const res = await fetchFn(sitePath(config, '/api/v1/user'), {
    headers: {Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json'}, credentials: 'omit', cache: 'no-store',
  });
  if (!res.ok) return fail(`Could not read the signed-in user (HTTP ${res.status}).`);
  const user = await res.json() as ApiUser;
  if (typeof user.id !== 'number' || user.id <= 0 || typeof user.login !== 'string') return fail('Could not read the signed-in user.');
  const userId = user.id;

  // Another user's data on this device: that user's session ended without a
  // sign-out. Their database is kept only if it holds unsynced intents (held
  // until they sign in again, PLAN §4.9); otherwise it is deleted.
  const previous = Number(readSplash().user);
  if (Number.isSafeInteger(previous) && previous > 0 && previous !== userId) {
    await deleteToken(previous, env.indexedDB).catch(() => undefined);
    await env.dropUser?.(previous).catch((err: unknown) => {
      console.error('sign-in: removing the previous user\'s data failed', err);
    });
    forgetUser();
  }

  unlistWipe(userId);
  const session = new AuthSession(oauth, userId, env);
  try {
    await session.adopt(grant, user.login);
    session.post({t: 'login', userId});
  } finally {
    session.close();
  }
  const initial = user.login.charAt(0).toUpperCase();
  writeSplash({user: String(userId), ...(initial ? {initial} : {})});
  await optIn(config, fetchFn);
  return {ok: true, userId, returnTo};
}
