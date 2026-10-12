// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Private settings are absent from the pool: views read them as resources cached per user.
// Optimistic writes roll back on refusal, while server-determined results await the answer.

import {online, RequestFailed} from '../../app/api.ts';
import {loadResource, type Resource, useResource} from '../../app/resource.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import type {APIPrimaryEmail, APIUserOptions} from '../../protocol/types.gen.ts';
import {
  type ApiEmail, type ApiGPGKey, type ApiPublicKey, applyPatch, mergeEmails, revertPatch, type SettingsPatch, type UserSettings, withPrimary,
} from './payload.ts';

export interface Kinds {
  settings: UserSettings;
  emails: ApiEmail[];
  keys: ApiPublicKey[];
  gpg: ApiGPGKey[];
  options: APIUserOptions;
}

export type Kind = keyof Kinds;

const PAGE = 50;
const MAX_PAGES = 20;

/** Repository 0 in the key: no repository revocation purges it. */
function key(userId: number, kind: Kind): string {
  return `uset:0:${String(userId)}:${kind}`;
}

function fetchKind<K extends Kind>(app: App, kind: K, signal?: AbortSignal): Promise<Kinds[K]>;
async function fetchKind(app: App, kind: Kind, signal?: AbortSignal): Promise<Kinds[Kind]> {
  switch (kind) {
    case 'settings':
      return need(await online<UserSettings>(app, {api: 'v1', path: '/user/settings', signal}));
    case 'emails':
      return (await online<ApiEmail[]>(app, {api: 'v1', path: '/user/emails', signal})) ?? [];
    case 'keys':
      return pages<ApiPublicKey>(app, '/user/keys', signal);
    case 'gpg':
      return pages<ApiGPGKey>(app, '/user/gpg_keys', signal);
    case 'options':
      return need(await online<APIUserOptions>(app, {api: 'sync', path: '/user/options', signal}));
  }
}

async function pages<T>(app: App, path: string, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  for (let n = 1; n <= MAX_PAGES; n++) {
    const part = await online<T[]>(app, {api: 'v1', path: `${path}?page=${String(n)}&limit=${String(PAGE)}`, signal});
    if (!part?.length) break;
    out.push(...part);
    if (part.length < PAGE) break;
  }
  return out;
}

/** One kind of the viewer's private settings, cached per user and asked again on every visit. */
export function useUserSettings<K extends Kind>(kind: K): Resource<Kinds[K]> {
  const app = useApp();
  return useResource(key(useSession().userId, kind), (signal) => fetchKind(app, kind, signal));
}

/** Route loaders prefetch on intent; the page then shows the answer without asking again. */
export function prefetchUserSettings(app: App, kinds: readonly Kind[]): void {
  const s = app.session;
  if (!s || !navigator.onLine) return;
  for (const kind of kinds) loadResource(app, key(s.userId, kind), () => fetchKind(app, kind)).catch(() => undefined);
}

/** Changes a loaded value; nothing to change before the first answer. */
function change<T>(res: Resource<T>, fn: (v: T) => T): void {
  if (res.value !== undefined) res.update((v) => fn(v as T));
}

/** Optimistic changes roll back on refusal (keeping later writes); otherwise the answer is shown. Throws RequestFailed. */
export async function patchSettings(app: App, res: Resource<UserSettings>, patch: SettingsPatch, optimistic: boolean): Promise<UserSettings> {
  const before = res.value;
  if (optimistic) change(res, (v) => applyPatch(v, patch));
  try {
    const answer = need(await online<UserSettings>(app, {method: 'PATCH', api: 'v1', path: '/user/settings', body: patch}));
    res.update(() => answer);
    return answer;
  } catch (err) {
    if (optimistic && before) change(res, (now) => revertPatch(now, before, patch));
    throw err;
  }
}

/** May trigger verification mail, depending on instance settings. */
export async function addEmail(app: App, res: Resource<ApiEmail[]>, email: string): Promise<void> {
  const added = await online<ApiEmail[]>(app, {method: 'POST', api: 'v1', path: '/user/emails', body: {emails: [email]}});
  res.update((list) => mergeEmails(list ?? [], added ?? []));
  res.reload();
}

/** Optimistic removal; Forgejo refuses removal of the primary address. */
export function deleteEmail(app: App, res: Resource<ApiEmail[]>, email: string): Promise<void> {
  const lower = email.toLowerCase();
  const gone = res.value?.find((e) => e.email.toLowerCase() === lower);
  return optimistic(res, (list) => list.filter((e) => e.email.toLowerCase() !== lower), (list) => (gone && !list.some((e) => e.email.toLowerCase() === lower) ? [...list, gone] : list),
    () => online(app, {method: 'DELETE', api: 'v1', path: '/user/emails', body: {emails: [email]}}));
}

/** Optimistic primary-address change via the gap endpoint; API v1 has no equivalent. */
export function makePrimary(app: App, res: Resource<ApiEmail[]>, email: string): Promise<void> {
  const was = res.value?.find((e) => e.primary)?.email;
  const body: APIPrimaryEmail = {email};
  return optimistic(res, (list) => withPrimary(list, email), (list) => (was ? withPrimary(list, was) : list),
    () => online(app, {method: 'PUT', api: 'sync', path: '/user/emails/primary', body}));
}

export async function addKey(app: App, res: Resource<ApiPublicKey[]>, title: string, armored: string): Promise<ApiPublicKey> {
  const k = need(await online<ApiPublicKey>(app, {method: 'POST', api: 'v1', path: '/user/keys', body: {title, key: armored}}));
  res.update((list) => [...(list ?? []).filter((x) => x.id !== k.id), k]);
  return k;
}

export function deleteKey(app: App, res: Resource<ApiPublicKey[]>, id: number): Promise<void> {
  const gone = res.value?.find((k) => k.id === id);
  return optimistic(res, (list) => list.filter((k) => k.id !== id), (list) => (gone && !list.some((k) => k.id === id) ? [...list, gone] : list),
    () => online(app, {method: 'DELETE', api: 'v1', path: `/user/keys/${String(id)}`}));
}

export async function addGpgKey(app: App, res: Resource<ApiGPGKey[]>, armored: string): Promise<ApiGPGKey> {
  const k = need(await online<ApiGPGKey>(app, {method: 'POST', api: 'v1', path: '/user/gpg_keys', body: {armored_public_key: armored}}));
  res.update((list) => [...(list ?? []).filter((x) => x.id !== k.id), k]);
  return k;
}

export function deleteGpgKey(app: App, res: Resource<ApiGPGKey[]>, id: number): Promise<void> {
  const gone = res.value?.find((k) => k.id === id);
  return optimistic(res, (list) => list.filter((k) => k.id !== id), (list) => (gone && !list.some((k) => k.id === id) ? [...list, gone] : list),
    () => online(app, {method: 'DELETE', api: 'v1', path: `/user/gpg_keys/${String(id)}`}));
}

/** Accepts base64 bytes; the synced User supplies the new avatar address. */
export async function uploadAvatar(app: App, image: string): Promise<void> {
  await online(app, {method: 'POST', api: 'v1', path: '/user/avatar', body: {image}, timeout: 60_000});
}

export async function deleteAvatar(app: App): Promise<void> {
  await online(app, {method: 'DELETE', api: 'v1', path: '/user/avatar'});
}

/** On failure, `undo` applies to the current list so concurrent changes survive. */
async function optimistic<T>(res: Resource<T>, apply: (v: T) => T, undo: (v: T) => T, send: () => Promise<unknown>): Promise<void> {
  change(res, apply);
  try {
    await send();
  } catch (err) {
    change(res, undo);
    throw err;
  }
}

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new RequestFailed(502, 'Forgejo sent no answer.');
  return v;
}
