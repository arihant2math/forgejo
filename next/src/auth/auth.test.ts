// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {readSplash, writeSplash} from '../app/splash.ts';
import {dbName, openDatabase} from '../data/idb.ts';
import type {NextConfig, NextOAuth} from '../protocol/types.gen.ts';
import {GrantRefused, onThisOrigin} from './oauth.ts';
import {challenge, randomToken} from './pkce.ts';
import {AuthSession, SignedOut} from './session.ts';
import {completeSignIn, startSignIn} from './signin.ts';
import {resumeWipes, signOut, wipeUser} from './signout.ts';
import {readToken, writeToken} from './tokens.ts';

const oauth: NextOAuth = {
  client_id: 'cid', redirect_uri: 'http://localhost:3000/-/next/callback', scope: 'write:issue write:repository read:user',
  authorize_url: '/login/oauth/authorize', token_url: '/login/oauth/access_token',
};
const config: NextConfig = {app_url: 'http://localhost:3000/', app_sub_url: '', base: '/-/next/', app_name: 'F', version: '', protocol: 1, oauth};

/** Serializes callbacks per name, like navigator.locks (enough for these tests). */
class FakeLocks {
  private chains = new Map<string, Promise<unknown>>();
  request<T>(name: string, cb: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const next = prev.then(cb, cb);
    this.chains.set(name, next.catch(() => undefined));
    return next;
  }
}

interface TokenCall {
  params: URLSearchParams;
}

/** A token endpoint: rotates refresh tokens like Forgejo (each works once). */
function tokenServer() {
  const calls: TokenCall[] = [];
  let valid = new Set(['r0']);
  let n = 0;
  let down = false;
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(url instanceof Request ? url.url : url.toString(), location.href);
    if (down) return Promise.reject(new TypeError('Failed to fetch'));
    if (u.pathname === '/api/v1/user') {
      return Promise.resolve(Response.json({id: 7, login: 'alice'}));
    }
    expect(u.pathname).toBe('/login/oauth/access_token');
    const params = new URLSearchParams(init?.body as string);
    calls.push({params});
    expect(params.get('client_id')).toBe('cid');
    if (params.get('grant_type') === 'authorization_code') {
      if (params.get('code') !== 'the-code' || !params.get('code_verifier')) return Promise.resolve(Response.json({error: 'invalid_grant'}, {status: 400}));
    } else {
      const r = params.get('refresh_token') ?? '';
      if (!valid.has(r)) return Promise.resolve(Response.json({error: 'unauthorized_client', error_description: 'token was already used'}, {status: 400}));
      valid.delete(r);
    }
    n++;
    valid = new Set([...valid, `r${String(n)}`]);
    return Promise.resolve(Response.json({access_token: `a${String(n)}`, refresh_token: `r${String(n)}`, expires_in: 3600, token_type: 'bearer'}));
  });
  return {
    fetch: fetchFn as unknown as typeof fetch, calls,
    setDown(v: boolean) {
      down = v;
    },
    revokeAll() {
      valid = new Set();
    },
  };
}

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pkce', () => {
  test('S256 challenge (RFC 7636 appendix B)', async () => {
    expect(await challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  test('verifiers are 43 URL-safe characters and random', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

test('OAuth endpoints are used on this page\'s origin', () => {
  expect(onThisOrigin('/login/oauth/access_token')).toBe(`${location.origin}/login/oauth/access_token`);
  expect(onThisOrigin('http://other.example/login/oauth/authorize?x=1')).toBe(`${location.origin}/login/oauth/authorize?x=1`);
});

describe('session', () => {
  async function session(server: ReturnType<typeof tokenServer>, locks: FakeLocks | null = null, bc: typeof BroadcastChannel | null = null) {
    await writeToken({userId: 7, login: 'alice', refreshToken: 'r0', updated: 0}, factory);
    return new AuthSession(oauth, 7, {fetch: server.fetch, indexedDB: factory, locks: locks as unknown as LockManager | null, BroadcastChannel: bc});
  }

  test('token() refreshes once, stores the rotated refresh token, then serves from memory', async () => {
    const server = tokenServer();
    const s = await session(server);
    expect(s.status.state).toBe('unknown');
    const [a, b] = await Promise.all([s.token(), s.token()]);
    expect(a).toBe('a1');
    expect(b).toBe('a1');
    expect(server.calls).toHaveLength(1);
    expect((await readToken(7, factory))?.refreshToken).toBe('r1');
    expect(s.status.state).toBe('ok');
    expect(await s.token()).toBe('a1');
    expect(server.calls).toHaveLength(1);
    s.close();
  });

  test('refresh() replaces a refused token', async () => {
    const server = tokenServer();
    const s = await session(server);
    expect(await s.token()).toBe('a1');
    expect(await s.refresh()).toBe('a2');
    expect((await readToken(7, factory))?.refreshToken).toBe('r2');
    s.close();
  });

  test('a refused refresh token: expired, deleted, and told to the other tabs; token() throws SignedOut', async () => {
    const server = tokenServer();
    server.revokeAll();
    const posted: unknown[] = [];
    class BC {
      postMessage(m: unknown) {
        posted.push(m);
      }
      addEventListener() {
        // Not needed.
      }
      close() {
        // Not needed.
      }
    }
    const s = await session(server, null, BC as unknown as typeof BroadcastChannel);
    expect(await s.refresh()).toBeNull();
    expect(s.status.state).toBe('expired');
    expect(await readToken(7, factory)).toBeUndefined();
    expect(posted).toContainEqual({t: 'expired', userId: 7});
    await expect(s.token()).rejects.toBeInstanceOf(SignedOut);
    s.close();
  });

  test('network down: offline, the refresh token is kept, and it works again later', async () => {
    const server = tokenServer();
    const s = await session(server);
    server.setDown(true);
    await expect(s.token()).rejects.toThrow('Failed to fetch');
    expect(s.status.state).toBe('offline');
    expect((await readToken(7, factory))?.refreshToken).toBe('r0');
    server.setDown(false);
    expect(await s.token()).toBe('a1');
    expect(s.status.state).toBe('ok');
    s.close();
  });

  test('two tabs: one refresh under the lock, the other takes the broadcast token (rotation-safe)', async () => {
    const server = tokenServer();
    const locks = new FakeLocks();
    const a = await session(server, locks, BroadcastChannel);
    const b = new AuthSession(oauth, 7, {fetch: server.fetch, indexedDB: factory, locks: locks as unknown as LockManager, BroadcastChannel});
    const ta = await a.token();
    // The broadcast arrives: b has a token without asking the server.
    await vi.waitFor(() => {
      expect(b.status.state).toBe('ok');
    });
    expect(await b.token()).toBe(ta);
    expect(server.calls).toHaveLength(1);
    // Both refresh at once after a 401: still one valid chain, no "already used" refusal.
    const [ra, rb] = await Promise.all([a.refresh(), b.refresh()]);
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    expect(a.status.state).toBe('ok');
    expect(b.status.state).toBe('ok');
    expect(server.calls.every((c) => c.params.get('grant_type') === 'refresh_token')).toBe(true);
    a.close();
    b.close();
  });

  test('background refresh before the access token expires', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
    const server = tokenServer();
    const s = await session(server);
    expect(await s.token()).toBe('a1');
    await vi.advanceTimersByTimeAsync(3600_000 - 120_000 + 10);
    await vi.waitFor(() => {
      expect(server.calls).toHaveLength(2);
    });
    expect(await s.token()).toBe('a2');
    s.close();
  });

  test('no OAuth client on the server: expired without a request', async () => {
    const s = new AuthSession(null, 7, {indexedDB: factory, locks: null, BroadcastChannel: null});
    await expect(s.token()).rejects.toBeInstanceOf(SignedOut);
    expect(s.status.state).toBe('expired');
  });
});

describe('sign-in', () => {
  async function start() {
    let url = '';
    await startSignIn(config, '/acme/website/issues?state=open', (u) => {
      url = u;
    });
    return new URL(url);
  }

  test('the authorization request: PKCE S256, exact scope, state, this origin\'s callback', async () => {
    const u = await start();
    expect(u.pathname).toBe('/login/oauth/authorize');
    const p = u.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('scope')).toBe(oauth.scope);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // jsdom's origin is not the server's AppURL: this origin's callback (dev loopback URIs).
    expect(p.get('redirect_uri')).toBe(`${location.origin}/-/next/callback`);
  });

  test('a completed sign-in stores the refresh token and the DB marker, and returns where it started', async () => {
    const server = tokenServer();
    const u = await start();
    const state = u.searchParams.get('state') ?? '';
    const r = await completeSignIn(config, `?code=the-code&state=${state}`, {fetch: server.fetch, indexedDB: factory, locks: null, BroadcastChannel: null});
    expect(r).toEqual({ok: true, userId: 7, returnTo: '/acme/website/issues?state=open'});
    const exchange = server.calls[0]?.params;
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('redirect_uri')).toBe(`${location.origin}/-/next/callback`);
    expect(await challenge(exchange?.get('code_verifier') ?? '')).toBe(u.searchParams.get('code_challenge'));
    expect((await readToken(7, factory))?.refreshToken).toBe('r1');
    expect(readSplash()).toMatchObject({user: '7', initial: 'A'});
    // The round trip is single-use.
    const again = await completeSignIn(config, `?code=the-code&state=${state}`, {fetch: server.fetch, indexedDB: factory});
    expect(again.ok).toBe(false);
  });

  test('a wrong state, an error, or no pending sign-in is refused without exchanging the code', async () => {
    const server = tokenServer();
    await start();
    expect(await completeSignIn(config, '?code=the-code&state=forged', {fetch: server.fetch, indexedDB: factory})).toMatchObject({ok: false});
    await start();
    expect(await completeSignIn(config, '?error=access_denied', {fetch: server.fetch, indexedDB: factory})).toMatchObject({ok: false, error: 'Access was denied.'});
    expect(server.calls).toHaveLength(0);
  });

  test('return paths are local only, and never the callback', async () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/-/next/callback?code=x']) {
      let url = '';
      await startSignIn(config, bad, (u) => {
        url = u;
      });
      const state = new URL(url).searchParams.get('state') ?? '';
      const r = await completeSignIn(config, `?code=the-code&state=${state}`, {fetch: tokenServer().fetch, indexedDB: factory, locks: null, BroadcastChannel: null});
      expect(r.returnTo).toBe('/');
    }
  });

  test('another user signing in: the previous user\'s data is handed to dropUser', async () => {
    writeSplash({user: '3', initial: 'B'});
    await writeToken({userId: 3, login: 'bob', refreshToken: 'x', updated: 0}, factory);
    const dropped: number[] = [];
    const u = await start();
    await completeSignIn(config, `?code=the-code&state=${u.searchParams.get('state') ?? ''}`, {
      fetch: tokenServer().fetch, indexedDB: factory, locks: null, BroadcastChannel: null,
      dropUser: (id) => {
        dropped.push(id);
        return Promise.resolve();
      },
    });
    expect(dropped).toEqual([3]);
    expect(await readToken(3, factory)).toBeUndefined();
    expect(readSplash().user).toBe('7');
  });
});

describe('sign-out', () => {
  async function exists(name: string): Promise<boolean> {
    return (await factory.databases()).some((d) => d.name === name);
  }

  test('forgets the marker, tells the other tabs, closes the data, deletes token and database', async () => {
    writeSplash({user: '7', initial: 'A', theme: 'dark'});
    await writeToken({userId: 7, login: 'alice', refreshToken: 'r', updated: 0}, factory);
    const db = await openDatabase(7, {factory});
    const posted: unknown[] = [];
    const auth = new AuthSession(oauth, 7, {indexedDB: factory, locks: null, BroadcastChannel: null});
    auth.post = (m) => posted.push(m);
    await signOut({auth, factory, close: () => {
      db.close();
      return Promise.resolve();
    }});
    expect(readSplash()).toEqual({theme: 'dark'});
    expect(posted).toEqual([{t: 'logout', userId: 7}]);
    expect(await readToken(7, factory)).toBeUndefined();
    expect(await exists(dbName(7))).toBe(false);
    expect(localStorage.getItem('forgejo-next:wipe')).toBeNull();
  });

  test('a wipe blocked by a tab that keeps the database open resumes at the next boot', async () => {
    vi.useFakeTimers({toFake: ['setTimeout']});
    const db = await openDatabase(8, {factory});
    db.onversionchange = null; // a tab that does not let go
    const wiping = wipeUser(8, factory);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await wiping).toBe(false);
    expect(localStorage.getItem('forgejo-next:wipe')).toBe('[8]');
    vi.useRealTimers();
    db.close();
    resumeWipes(undefined);
    await vi.waitFor(() => {
      expect(localStorage.getItem('forgejo-next:wipe')).toBeNull();
    });
  });

  test('resumeWipes never deletes the current user', () => {
    localStorage.setItem('forgejo-next:wipe', '[7]');
    resumeWipes(7);
    expect(localStorage.getItem('forgejo-next:wipe')).toBe('[7]');
  });
});

test('GrantRefused carries the OAuth error code', () => {
  const e = new GrantRefused('invalid_grant', 'expired');
  expect(e.code).toBe('invalid_grant');
  expect(e.message).toBe('invalid_grant: expired');
});
