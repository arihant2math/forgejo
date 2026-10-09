// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo's OAuth2 token endpoint (routers/web/auth/oauth.go) for the Next
// UI's public client: the authorization code grant with PKCE, and the
// refresh token grant. No secret. Forgejo rotates refresh tokens by default
// ([oauth2] INVALIDATE_REFRESH_TOKENS): each one works once, so a refresh
// must store the new one before anything else may refresh (session.ts).

import type {NextOAuth} from '../protocol/types.gen.ts';

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires (ms since the epoch). */
  expiresAt: number;
}

/** The server refused the grant: the code or refresh token is not valid (any more). */
export class GrantRefused extends Error {
  readonly code: string;
  constructor(code: string, description: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'GrantRefused';
    this.code = code;
  }
}

/** The endpoint on this page's origin (the same server; avoids CORS when AppURL names another host). */
export function onThisOrigin(url: string): string {
  const u = new URL(url, location.href);
  return u.origin === location.origin ? u.href : new URL(`${u.pathname}${u.search}`, location.origin).href;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function post(oauth: NextOAuth, params: Record<string, string>, fetchFn: typeof fetch, now: number): Promise<TokenGrant> {
  // Network errors propagate as they are: the caller retries later.
  const res = await fetchFn(onThisOrigin(oauth.token_url), {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'},
    body: new URLSearchParams({...params, client_id: oauth.client_id}),
    credentials: 'omit',
    cache: 'no-store',
    // A stalled endpoint must not hold the refresh lock (every tab waits on it) forever.
    signal: AbortSignal.timeout(15_000),
  });
  let body: TokenResponse = {};
  try {
    body = await res.json() as TokenResponse;
  } catch {
    // Not JSON (a proxy's error page).
  }
  if (res.status === 400 || res.status === 401) {
    throw new GrantRefused(typeof body.error === 'string' ? body.error : `http ${res.status}`,
      typeof body.error_description === 'string' ? body.error_description : '');
  }
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
  const {access_token: access, refresh_token: refresh, expires_in: expires} = body;
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) throw new Error('token endpoint: malformed response');
  const seconds = typeof expires === 'number' && expires > 0 ? expires : 3600;
  return {accessToken: access, refreshToken: refresh, expiresAt: now + seconds * 1000};
}

export function exchangeCode(oauth: NextOAuth, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<TokenGrant> {
  return post(oauth, {grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri}, fetchFn, now);
}

export function refreshGrant(oauth: NextOAuth, refreshToken: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<TokenGrant> {
  return post(oauth, {grant_type: 'refresh_token', refresh_token: refreshToken}, fetchFn, now);
}
