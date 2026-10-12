// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Writes are online-only and never queued; wait for sync/entity arrival before closing dialogs.
// Unsynced draft releases use API v1 plus a local cache, refreshed when the view opens.

import {observable, runInAction, untracked, when} from 'mobx';
import {failureText, online, onlineWrite, type OnlineRequest} from '../../app/api.ts';
import type {App, Session} from '../../app/store.ts';
import {repoGroup} from '../../data/models.ts';
import {codeSource, encodePath} from '../../code/source.ts';
import {type ApiRelease, assetUploadPath, type DraftRelease, draftsOf} from './refWrite.ts';

const SYNC_WAIT_MS = 5000;
const UPLOAD_MS = 10 * 60_000;

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

export function repoRef(s: Session, repoId: number): RepoRef | undefined {
  const r = untracked(() => s.data.pool.model('Repository').get(repoId)?.data);
  return r ? {id: r.id, owner: r.owner_name, name: r.name} : undefined;
}

const apiRepo = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;

function session(app: App): Session {
  const s = app.session;
  if (!s) throw new Error('Not signed in.');
  return s;
}

async function settle(app: App, repoId: number, syncId: number | undefined, until: (() => boolean) | undefined): Promise<void> {
  const s = session(app);
  const signal = AbortSignal.timeout(SYNC_WAIT_MS);
  if (syncId) await s.data.whenSynced(repoGroup(repoId), syncId, signal).catch(() => undefined);
  if (until && !signal.aborted) await when(until, {signal}).catch(() => undefined);
}

async function write<T>(app: App, repo: RepoRef, req: Omit<OnlineRequest, 'api'>, until?: () => boolean): Promise<T | undefined> {
  const w = await onlineWrite<T>(app, {...req, api: 'v1', path: `${apiRepo(repo)}${req.path}`});
  await settle(app, repo.id, w.syncId, until);
  return w.value;
}

const liveBranch = (s: Session, repoId: number, name: string) =>
  [...s.data.pool.model('Branch').by('repo_id', repoId)].some((b) => b.get('name') === name && !b.get('is_deleted'));

const tagOf = (s: Session, repoId: number, tag: string) =>
  [...s.data.pool.model('Release').by('repo_id', repoId)].find((r) => r.get('tag_name') === tag && Boolean(r.get('sha')))?.data;

export async function createBranch(app: App, repo: RepoRef, body: {new_branch_name: string; old_ref_name: string}): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'POST', path: '/branches', body}, () => liveBranch(s, repo.id, body.new_branch_name));
}

export async function deleteBranch(app: App, repo: RepoRef, name: string): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'DELETE', path: `/branches/${encodePath(name)}`}, () => !liveBranch(s, repo.id, name));
}

export async function branchProtected(app: App, repo: RepoRef, name: string, signal?: AbortSignal): Promise<boolean> {
  const b = await online<{protected?: boolean}>(app, {api: 'v1', path: `${apiRepo(repo)}/branches/${encodePath(name)}`, signal});
  return b?.protected === true;
}

export async function createTag(app: App, repo: RepoRef, body: {tag_name: string; target: string; message: string}): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'POST', path: '/tags', body}, () => tagOf(s, repo.id, body.tag_name) !== undefined);
}

export async function deleteTag(app: App, repo: RepoRef, name: string): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'DELETE', path: `/tags/${encodePath(name)}`}, () => tagOf(s, repo.id, name) === undefined);
}

const published = (s: Session, id: number) => s.data.pool.model('Release').get(id)?.data;

/** Published releases reach the pool before resolution, unless SYNC_WAIT_MS expires. */
export async function createRelease(app: App, repo: RepoRef, body: {tag_name: string; draft: boolean} & Record<string, unknown>): Promise<number> {
  const s = session(app);
  const w = await onlineWrite<ApiRelease>(app, {method: 'POST', api: 'v1', path: `${apiRepo(repo)}/releases`, body});
  const id = w.value?.id;
  if (typeof id !== 'number') throw new Error('Forgejo did not say which release it made.');
  if (body.draft) drafts(app).changed(repo);
  else await settle(app, repo.id, w.syncId, () => published(s, id)?.is_tag === false);
  return id;
}

/** Wait for the pool to reflect the edit, or for SYNC_WAIT_MS to expire. */
export async function editRelease(app: App, repo: RepoRef, id: number, body: {draft: boolean; name: string; prerelease: boolean} & Record<string, unknown>): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'PATCH', path: `/releases/${String(id)}`, body}, () => {
    const r = published(s, id);
    return body.draft ? r === undefined || r.draft : r !== undefined && !r.draft && r.name === body.name && r.prerelease === body.prerelease;
  });
  drafts(app).changed(repo);
}

/** Deleting a release leaves its tag. */
export async function deleteRelease(app: App, repo: RepoRef, id: number, draft: boolean): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'DELETE', path: `/releases/${String(id)}`}, () => {
    const r = published(s, id);
    return r === undefined || r.is_tag;
  });
  if (draft) drafts(app).drop(repo.id, id);
}

/** Uploads a file as a release's asset (multipart, no Idempotency-Key: see OnlineRequest.form). */
export async function uploadAsset(app: App, repo: RepoRef, releaseId: number, file: File): Promise<void> {
  const form = new FormData();
  form.append('attachment', file, file.name);
  await onlineWrite(app, {method: 'POST', api: 'v1', path: assetUploadPath(apiRepo(repo), releaseId, file.name), form, timeout: UPLOAD_MS});
}

export async function deleteAsset(app: App, repo: RepoRef, releaseId: number, assetId: number): Promise<void> {
  await onlineWrite(app, {method: 'DELETE', api: 'v1', path: `${apiRepo(repo)}/releases/${String(releaseId)}/assets/${String(assetId)}`});
}

export type DraftSlot =
  | {state: 'loading'}
  /** `stale`: the device's copy, while Forgejo is asked. */
  | {state: 'ready'; list: DraftRelease[]; stale: boolean}
  | {state: 'offline'}
  | {state: 'error'; message: string};

const FRESH_MS = 15_000;

const draftsKey = (repoId: number) => `drafts:${String(repoId)}`;

export class Drafts {
  private readonly slots = observable.map<number, DraftSlot>({}, {deep: false});
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly asked = new Map<number, number>();
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** Observable slot, initialized from memory before loading. */
  slot(repoId: number): DraftSlot {
    const s = this.slots.get(repoId);
    if (s) return s;
    const hit = codeSource(this.app)?.peek<DraftRelease[]>(draftsKey(repoId));
    return hit ? {state: 'ready', list: hit, stale: true} : {state: 'loading'};
  }

  find(repoId: number, pred: (d: DraftRelease) => boolean): DraftRelease | undefined {
    const s = this.slot(repoId);
    return s.state === 'ready' ? s.list.find(pred) : undefined;
  }

  /** Show cached drafts, then fetch at most once per FRESH_MS unless forced. */
  load(repo: RepoRef, force = false): Promise<void> {
    const running = this.inflight.get(repo.id);
    if (running) return running;
    if (!force && Date.now() - (this.asked.get(repo.id) ?? 0) < FRESH_MS && this.slots.get(repo.id)?.state === 'ready') return Promise.resolve();
    const src = codeSource(this.app);
    const p = (async () => {
      const cur = this.slots.get(repo.id);
      const old = cur?.state === 'ready' ? cur.list : await src?.cache.get<DraftRelease[]>(draftsKey(repo.id));
      if (old && cur?.state !== 'ready') this.set(repo.id, {state: 'ready', list: old, stale: true});
      if (!navigator.onLine) {
        this.set(repo.id, old ? {state: 'ready', list: old, stale: false} : {state: 'offline'});
        return;
      }
      try {
        const list = draftsOf(await online<ApiRelease[]>(this.app, {api: 'v1', path: `${apiRepo(repo)}/releases?draft=true&limit=50`}) ?? []);
        this.asked.set(repo.id, Date.now());
        src?.cache.put(draftsKey(repo.id), list);
        this.set(repo.id, {state: 'ready', list, stale: false});
      } catch (err) {
        this.set(repo.id, old ? {state: 'ready', list: old, stale: false} : {state: 'error', message: failureText(err)});
      }
    })().finally(() => {
      this.inflight.delete(repo.id);
    });
    this.inflight.set(repo.id, p);
    return p;
  }

  changed(repo: RepoRef): void {
    this.asked.delete(repo.id);
    void this.load(repo, true);
  }

  drop(repoId: number, id: number): void {
    const s = this.slots.get(repoId);
    if (s?.state !== 'ready') return;
    const list = s.list.filter((d) => d.id !== id);
    codeSource(this.app)?.cache.put(draftsKey(repoId), list);
    this.set(repoId, {...s, list});
  }

  private set(repoId: number, slot: DraftSlot): void {
    runInAction(() => {
      this.slots.set(repoId, slot);
    });
  }
}

const stores = new WeakMap<Session, Drafts>();

export function drafts(app: App): Drafts {
  const s = session(app);
  let d = stores.get(s);
  if (!d) stores.set(s, d = new Drafts(app));
  return d;
}
