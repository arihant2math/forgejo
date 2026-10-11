// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's settings: read through API v1 (/user/settings, /user/emails,
// /user/keys, /user/gpg_keys) and the gap endpoint of the appearance
// choices (/-/sync/api/user/options). None of it is in the sync pool (the
// pool's User has the public profile only, which the profile page paints
// first), so what was fetched is kept in the code cache (memory LRU over
// IndexedDB) by user and shown at once the next time, offline too, while it
// is asked for again (stale while revalidate). Writes are online only:
// optimistic where a failure is easy to undo (a switch, a choice, a delete,
// the primary address: shown at once, put back when Forgejo refuses),
// awaited where Forgejo decides what the result is (a profile with its
// validation, an added address or key).

import {observable, runInAction} from 'mobx';
import {online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {CodeCache} from '../../code/cache.ts';
import {codeSource} from '../../code/source.ts';
import type {APIPrimaryEmail, APIUserOptions} from '../../protocol/types.gen.ts';
import {
  type ApiEmail, type ApiGPGKey, type ApiPublicKey, applyPatch, mergeEmails, revertPatch, type SettingsPatch, type UserSettings, withPrimary,
} from './payload.ts';

export type Slot<T> =
  | {state: 'loading'}
  /** `stale`: from the cache, asked for again. */
  | {state: 'ready'; value: T; stale: boolean}
  /** Offline (or unreachable) and not on this device. */
  | {state: 'offline'}
  | {state: 'error'; message: string; status: number};

/** What the pages read, by kind. */
export interface Kinds {
  settings: UserSettings;
  emails: ApiEmail[];
  keys: ApiPublicKey[];
  gpg: ApiGPGKey[];
  options: APIUserOptions;
}

export type Kind = keyof Kinds;

/** An answer this recent is not asked for again (a hover's prefetch, then the click). */
const FRESH = 30_000;

/** Keys per request, and requests at most (an account has a handful). */
const PAGE = 50;
const MAX_PAGES = 20;

export class SettingsSource {
  private readonly slots = observable.map<Kind, Slot<unknown>>({}, {deep: false});
  private readonly asked = new Map<Kind, number>();
  private readonly inflight = new Map<Kind, Promise<void>>();
  private readonly app: App;
  private readonly cache: CodeCache;
  private readonly userId: number;

  constructor(app: App, cache: CodeCache, userId: number) {
    this.app = app;
    this.cache = cache;
    this.userId = userId;
  }

  /** The cache key ("kind:<repo>:…": no repository, the user's own). */
  private key(kind: Kind): string {
    return `uset:0:${String(this.userId)}:${kind}`;
  }

  /** What is known now (observed; memory only: the view's first frame). */
  slot<K extends Kind>(kind: K): Slot<Kinds[K]> {
    const s = this.slots.get(kind) as Slot<Kinds[K]> | undefined;
    if (s) return s;
    const hit = this.cache.peek<Kinds[K]>(this.key(kind));
    return hit === undefined ? {state: 'loading'} : {state: 'ready', value: hit, stale: true};
  }

  /** The value now, if any. */
  value<K extends Kind>(kind: K): Kinds[K] | undefined {
    const s = this.slot(kind);
    return s.state === 'ready' ? s.value : undefined;
  }

  private set<K extends Kind>(kind: K, s: Slot<Kinds[K]>): void {
    runInAction(() => {
      this.slots.set(kind, s);
    });
  }

  /** A new value (a write's answer, an optimistic copy): shown and kept. */
  private put<K extends Kind>(kind: K, v: Kinds[K]): void {
    this.cache.put(this.key(kind), v);
    this.set(kind, {state: 'ready', value: v, stale: false});
  }

  /**
   * Loads one kind: the device's copy first (stale), then Forgejo unless asked in the last moments. One request
   * per kind at a time; offline or unreachable the copy stays.
   */
  load(kind: Kind, force = false): Promise<void> {
    const running = this.inflight.get(kind);
    if (running) return running;
    const cur = this.slots.get(kind);
    if (!force && cur?.state === 'ready' && !cur.stale && Date.now() - (this.asked.get(kind) ?? 0) < FRESH) return Promise.resolve();
    const key = this.key(kind);
    const p = (async () => {
      let old = cur?.state === 'ready' ? cur.value : this.cache.peek(key);
      old ??= await this.cache.get(key);
      if (old !== undefined && cur?.state !== 'ready') this.set(kind, {state: 'ready', value: old as never, stale: true});
      if (!navigator.onLine) {
        this.set(kind, old === undefined ? {state: 'offline'} : {state: 'ready', value: old as never, stale: false});
        return;
      }
      try {
        const v = await this.fetch(kind);
        this.asked.set(kind, Date.now());
        this.put(kind, v);
      } catch (err) {
        const status = err instanceof RequestFailed ? err.status : 0;
        if (old !== undefined) this.set(kind, {state: 'ready', value: old as never, stale: false});
        else if (status === 0) this.set(kind, {state: 'offline'});
        else this.set(kind, {state: 'error', message: err instanceof Error ? err.message : String(err), status});
      }
    })().finally(() => {
      this.inflight.delete(kind);
    });
    this.inflight.set(kind, p);
    return p;
  }

  /** Loads ahead (a section's link hovered); errors are the page's to show. */
  prefetch(...kinds: Kind[]): void {
    if (!navigator.onLine) return;
    for (const k of kinds) this.load(k).catch(() => undefined);
  }

  private async fetch(kind: Kind): Promise<Kinds[Kind]> {
    switch (kind) {
      case 'settings':
        return need(await online<UserSettings>(this.app, {api: 'v1', path: '/user/settings'}));
      case 'emails':
        return (await online<ApiEmail[]>(this.app, {api: 'v1', path: '/user/emails'})) ?? [];
      case 'keys':
        return this.pages<ApiPublicKey>('/user/keys');
      case 'gpg':
        return this.pages<ApiGPGKey>('/user/gpg_keys');
      case 'options':
        return need(await online<APIUserOptions>(this.app, {api: 'sync', path: '/user/options'}));
    }
  }

  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const part = await online<T[]>(this.app, {api: 'v1', path: `${path}?page=${String(n)}&limit=${String(PAGE)}`});
      if (!part?.length) break;
      out.push(...part);
      if (part.length < PAGE) break;
    }
    return out;
  }

  // ---- Writes (online only) ----

  /**
   * Changes settings (PATCH /user/settings). `optimistic`: shown at once and put back when Forgejo refuses (a
   * switch, a choice); otherwise shown once Forgejo answers (the profile form, which shows its draft meanwhile).
   * Resolves with Forgejo's settings; throws RequestFailed.
   */
  async patch(patch: SettingsPatch, optimistic: boolean): Promise<UserSettings> {
    const before = this.value('settings');
    if (optimistic && before) this.put('settings', applyPatch(before, patch));
    try {
      const res = need(await online<UserSettings>(this.app, {method: 'PATCH', api: 'v1', path: '/user/settings', body: patch}));
      this.asked.set('settings', Date.now());
      this.put('settings', res);
      return res;
    } catch (err) {
      const now = this.value('settings');
      if (optimistic && before && now) this.put('settings', revertPatch(now, before, patch));
      throw err;
    }
  }

  /** Adds an address (Forgejo mails it to be verified when the instance asks for that). */
  async addEmail(email: string): Promise<void> {
    const added = await online<ApiEmail[]>(this.app, {method: 'POST', api: 'v1', path: '/user/emails', body: {emails: [email]}});
    this.put('emails', mergeEmails(this.value('emails') ?? [], added ?? []));
    void this.load('emails', true);
  }

  /** Removes an address (never the primary one: Forgejo refuses). Optimistic. */
  async deleteEmail(email: string): Promise<void> {
    const lower = email.toLowerCase();
    const gone = this.value('emails')?.find((e) => e.email.toLowerCase() === lower);
    await this.optimistic('emails', (list) => list.filter((e) => e.email.toLowerCase() !== lower), (list) => (gone && !list.some((e) => e.email.toLowerCase() === lower) ? [...list, gone] : list),
      () => online(this.app, {method: 'DELETE', api: 'v1', path: '/user/emails', body: {emails: [email]}}));
  }

  /** Makes a verified address the primary one (the gap endpoint: API v1 has none). Optimistic. */
  async makePrimary(email: string): Promise<void> {
    const was = this.value('emails')?.find((e) => e.primary)?.email;
    const body: APIPrimaryEmail = {email};
    await this.optimistic('emails', (list) => withPrimary(list, email), (list) => (was ? withPrimary(list, was) : list),
      () => online(this.app, {method: 'PUT', api: 'sync', path: '/user/emails/primary', body}));
  }

  async addKey(title: string, key: string): Promise<ApiPublicKey> {
    const res = need(await online<ApiPublicKey>(this.app, {method: 'POST', api: 'v1', path: '/user/keys', body: {title, key}}));
    this.put('keys', [...(this.value('keys') ?? []).filter((k) => k.id !== res.id), res]);
    return res;
  }

  async deleteKey(id: number): Promise<void> {
    const gone = this.value('keys')?.find((k) => k.id === id);
    await this.optimistic('keys', (list) => list.filter((k) => k.id !== id), (list) => (gone && !list.some((k) => k.id === id) ? [...list, gone] : list),
      () => online(this.app, {method: 'DELETE', api: 'v1', path: `/user/keys/${String(id)}`}));
  }

  async addGpgKey(armored: string): Promise<ApiGPGKey> {
    const res = need(await online<ApiGPGKey>(this.app, {method: 'POST', api: 'v1', path: '/user/gpg_keys', body: {armored_public_key: armored}}));
    this.put('gpg', [...(this.value('gpg') ?? []).filter((k) => k.id !== res.id), res]);
    return res;
  }

  async deleteGpgKey(id: number): Promise<void> {
    const gone = this.value('gpg')?.find((k) => k.id === id);
    await this.optimistic('gpg', (list) => list.filter((k) => k.id !== id), (list) => (gone && !list.some((k) => k.id === id) ? [...list, gone] : list),
      () => online(this.app, {method: 'DELETE', api: 'v1', path: `/user/gpg_keys/${String(id)}`}));
  }

  /** A new profile picture (base64 bytes); the pool's User brings its new address. */
  async uploadAvatar(image: string): Promise<void> {
    await online(this.app, {method: 'POST', api: 'v1', path: '/user/avatar', body: {image}, timeout: 60_000});
  }

  async deleteAvatar(): Promise<void> {
    await online(this.app, {method: 'DELETE', api: 'v1', path: '/user/avatar'});
  }

  /** A list change shown at once; `undo` puts it back into the list as it is then when Forgejo refuses. */
  private async optimistic<K extends 'emails' | 'keys' | 'gpg'>(kind: K, apply: (v: Kinds[K]) => Kinds[K], undo: (v: Kinds[K]) => Kinds[K], send: () => Promise<unknown>): Promise<void> {
    const cur = this.value(kind);
    if (cur) this.put(kind, apply(cur));
    try {
      await send();
    } catch (err) {
      const now = this.value(kind);
      if (now) this.put(kind, undo(now));
      throw err;
    }
  }
}

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new RequestFailed(502, 'Forgejo sent no answer.');
  return v;
}

const sources = new WeakMap<object, SettingsSource>();

/** The session's settings source (started on first use). */
export function settingsSource(app: App): SettingsSource | undefined {
  const s = app.session;
  const code = codeSource(app);
  if (!s || !code) return undefined;
  let src = sources.get(s);
  if (!src) sources.set(s, src = new SettingsSource(app, code.cache, s.userId));
  return src;
}
