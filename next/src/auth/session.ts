// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Refused refresh tokens expire the session without wiping local data.
// Single-use refresh tokens are rotated under a cross-tab Web Lock and stored before releasing it, with the access
// token: a new document reuses that instead of rotating again, since a navigation that interrupts a refresh the
// server already answered loses the rotated token and with it the session.

import {observable, runInAction} from 'mobx';
import type {NextOAuth} from '../protocol/types.gen.ts';
import type {SyncAuth} from '../sync/client.ts';
import {GrantRefused, refreshGrant, type TokenGrant} from './oauth.ts';
import {deleteToken, readToken, writeToken} from './tokens.ts';

export const AUTH_CHANNEL = 'forgejo-next:auth';

export type AuthMessage =
  | {t: 'token'; userId: number; token: string; expiresAt: number}
  | {t: 'expired'; userId: number}
  | {t: 'login'; userId: number}
  | {t: 'logout'; userId: number};

/** unknown: not authenticated yet; offline: endpoint unreachable; expired: sign-in required. */
export type AuthState = 'unknown' | 'ok' | 'offline' | 'expired';

export class SignedOut extends Error {
  constructor() {
    super('signed out');
    this.name = 'SignedOut';
  }
}

export interface AuthEnv {
  fetch?: typeof fetch;
  indexedDB?: IDBFactory;
  /** null: no Web Locks (refreshes are then only serialized within the tab). */
  locks?: LockManager | null;
  /** null: no BroadcastChannel. */
  BroadcastChannel?: typeof BroadcastChannel | null;
  now?: () => number;
}

/** Refresh this long before the access token expires. */
const EARLY = 120_000;

function stored(grant: TokenGrant, now: number) {
  return {refreshToken: grant.refreshToken, updated: now, accessToken: grant.accessToken, expiresAt: grant.expiresAt};
}

export class AuthSession implements SyncAuth {
  readonly userId: number;
  readonly status: {state: AuthState};
  private readonly oauth: NextOAuth | null;
  private readonly env: AuthEnv;
  private readonly channel: BroadcastChannel | undefined;
  private access: {token: string; expiresAt: number} | undefined;
  private running: Promise<string | null> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(oauth: NextOAuth | null, userId: number, env: AuthEnv = {}) {
    this.oauth = oauth;
    this.userId = userId;
    this.env = env;
    this.status = observable<{state: AuthState}>({state: 'unknown'});
    const BC: typeof BroadcastChannel | null | undefined = env.BroadcastChannel === undefined ? globalThis.BroadcastChannel : env.BroadcastChannel;
    if (BC) {
      this.channel = new BC(AUTH_CHANNEL);
      this.channel.addEventListener('message', (ev: MessageEvent<AuthMessage>) => {
        this.onMessage(ev.data);
      });
    }
  }

  private now(): number {
    return (this.env.now ?? Date.now)();
  }

  private setState(state: AuthState): void {
    if (this.status.state !== state) runInAction(() => {
      this.status.state = state;
    });
  }

  private onMessage(m: AuthMessage): void {
    if (this.closed || m.userId !== this.userId) return;
    switch (m.t) {
      case 'token':
        this.setAccess(m.token, m.expiresAt);
        break;
      case 'expired':
        this.access = undefined;
        this.setState('expired');
        break;
      case 'login':
        // Another tab signed this user in again: the next token() refreshes with the new refresh token.
        if (this.status.state === 'expired') this.setState('unknown');
        break;
      case 'logout':
        break; // the app handles it (it reloads)
    }
  }

  /** Posts to the other tabs (not to this one). */
  post(m: AuthMessage): void {
    try {
      this.channel?.postMessage(m);
    } catch (err) {
      console.error('auth: broadcast failed', err);
    }
  }

  onBroadcast(fn: (m: AuthMessage) => void): () => void {
    const h = (ev: MessageEvent<AuthMessage>) => {
      fn(ev.data);
    };
    this.channel?.addEventListener('message', h);
    return () => this.channel?.removeEventListener('message', h);
  }

  private setAccess(token: string, expiresAt: number): void {
    this.access = {token, expiresAt};
    this.setState('ok');
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.access) return;
    const delay = Math.max(1000, this.access.expiresAt - EARLY - this.now());
    // Timers clamp at 2^31-1 ms.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.fresh()) void this.renew().catch(() => undefined);
    }, Math.min(delay, 2 ** 31 - 1));
  }

  private fresh(): string | undefined {
    const a = this.access;
    return a && a.expiresAt - EARLY > this.now() ? a.token : undefined;
  }

  /** Stores the grant under the refresh lock and broadcasts its access token. */
  async adopt(grant: TokenGrant, login: string): Promise<void> {
    await this.withLock(() => writeToken({userId: this.userId, login, ...stored(grant, this.now())}, this.env.indexedDB));
    this.setAccess(grant.accessToken, grant.expiresAt);
    this.post({t: 'token', userId: this.userId, token: grant.accessToken, expiresAt: grant.expiresAt});
  }

  /** A current access token (SyncAuth). Throws SignedOut without a session, or a network error. */
  async token(): Promise<string> {
    const t = this.fresh();
    if (t) return t;
    const renewed = await this.renew();
    if (renewed === null) throw new SignedOut();
    return renewed;
  }

  /** Replaces a refused access token; null means signed out. Throws on network errors. */
  refresh(): Promise<string | null> {
    return this.renew(this.access?.token);
  }

  /** `stale` is the refused token; concurrent calls share one refresh. */
  private renew(stale?: string): Promise<string | null> {
    this.running ??= this.locked(stale).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private locked(stale: string | undefined): Promise<string | null> {
    return this.withLock(() => this.doRefresh(stale));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = this.env.locks === undefined ? (globalThis.navigator as Navigator | undefined)?.locks : this.env.locks;
    if (!locks) return fn();
    return await locks.request(`${AUTH_CHANNEL}:${String(this.userId)}`, fn);
  }

  private async doRefresh(stale: string | undefined): Promise<string | null> {
    if (this.closed) throw new Error('auth session closed');
    // Another tab refreshed while this one waited for the lock (its token was broadcast).
    const t = this.fresh();
    if (t && t !== stale) return t;
    if (this.status.state === 'expired') return null;
    if (!this.oauth) {
      this.setState('expired');
      return null;
    }
    const rec = await readToken(this.userId, this.env.indexedDB);
    if (!rec) {
      this.expire();
      return null;
    }
    if (rec.accessToken && rec.accessToken !== stale && (rec.expiresAt ?? 0) - EARLY > this.now()) {
      this.setAccess(rec.accessToken, rec.expiresAt ?? 0);
      return rec.accessToken;
    }
    let grant: TokenGrant;
    try {
      grant = await refreshGrant(this.oauth, rec.refreshToken, this.env.fetch ?? fetch.bind(globalThis), this.now());
    } catch (err) {
      if (err instanceof GrantRefused) {
        // Delete only the refused token: a concurrent sign-in may store a new chain.
        const now = await readToken(this.userId, this.env.indexedDB).catch(() => undefined);
        if (now?.refreshToken === rec.refreshToken) await deleteToken(this.userId, this.env.indexedDB).catch(() => undefined);
        this.expire();
        return null;
      }
      this.setState('offline');
      throw err;
    }
    // Signed out while the request ran: never write a token back after the wipe.
    if (this.isClosed()) return null;
    // Store the rotated token before releasing the lock; the consumed token cannot be reused.
    await writeToken({...rec, ...stored(grant, this.now())}, this.env.indexedDB);
    this.setAccess(grant.accessToken, grant.expiresAt);
    this.post({t: 'token', userId: this.userId, token: grant.accessToken, expiresAt: grant.expiresAt});
    return grant.accessToken;
  }

  /** A method, so a check after an await is not narrowed away by the one before it. */
  private isClosed(): boolean {
    return this.closed;
  }

  private expire(): void {
    this.access = undefined;
    this.setState('expired');
    this.post({t: 'expired', userId: this.userId});
  }

  /** Deletes under the refresh lock so in-flight refreshes cannot restore the token. */
  async forget(): Promise<void> {
    this.close();
    await this.withLock(() => deleteToken(this.userId, this.env.indexedDB));
  }

  close(): void {
    this.closed = true;
    this.access = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.channel?.close();
  }
}
