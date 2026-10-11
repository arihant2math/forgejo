// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The writes of the branches, tags and releases views (PLAN §5.4: code
// operations, online only, never queued): API v1, then a wait — at most
// SYNC_WAIT_MS — until the pool holds the change (the echoed sync id, then
// the entity itself: a branch made by a push arrives through Forgejo's
// hooks), so the list shows it the moment the dialog closes. Draft releases
// are in no sync group (B3): a writer's drafts come from API v1, kept in the
// code cache (shown at once on the next visit, offline too) and asked for
// again when the releases view opens.

import {observable, runInAction, untracked, when} from 'mobx';
import {online, onlineWrite, type OnlineRequest} from '../../app/api.ts';
import type {App, Session} from '../../app/store.ts';
import {codeSource, encodePath} from '../../code/source.ts';
import {type ApiRelease, assetUploadPath, type DraftRelease, draftsOf} from './refWrite.ts';

/** How long a write waits for the pool to show it before the view goes on anyway (it shows up then). */
const SYNC_WAIT_MS = 5000;
/** An upload's deadline (a release's asset can be large). */
const UPLOAD_MS = 10 * 60_000;

/** The repository a write goes to (its names as API v1 addresses them). */
export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

/** The repository as the pool has it, or undefined (not on this device). */
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

/** Waits until the pool holds the repository's group up to `syncId` and `until` holds, SYNC_WAIT_MS at most. */
async function settle(app: App, repoId: number, syncId: number | undefined, until: (() => boolean) | undefined): Promise<void> {
  const s = session(app);
  const signal = AbortSignal.timeout(SYNC_WAIT_MS);
  const late = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    });
  });
  const arrived = (async () => {
    if (syncId) await s.data.whenSynced(`repo:${String(repoId)}`, syncId, signal).catch(() => undefined);
    if (until && !signal.aborted) await when(until, {signal}).catch(() => undefined);
  })();
  await Promise.race([arrived, late]);
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

// ---- Branches ----

export async function createBranch(app: App, repo: RepoRef, body: {new_branch_name: string; old_ref_name: string}): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'POST', path: '/branches', body}, () => liveBranch(s, repo.id, body.new_branch_name));
}

export async function deleteBranch(app: App, repo: RepoRef, name: string): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'DELETE', path: `/branches/${encodePath(name)}`}, () => !liveBranch(s, repo.id, name));
}

/** Whether Forgejo protects a branch (API v1's branch: its first matching protection rule). */
export async function branchProtected(app: App, repo: RepoRef, name: string, signal?: AbortSignal): Promise<boolean> {
  const b = await online<{protected?: boolean}>(app, {api: 'v1', path: `${apiRepo(repo)}/branches/${encodePath(name)}`, signal});
  return b?.protected === true;
}

// ---- Tags ----

export async function createTag(app: App, repo: RepoRef, body: {tag_name: string; target: string; message: string}): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'POST', path: '/tags', body}, () => tagOf(s, repo.id, body.tag_name) !== undefined);
}

export async function deleteTag(app: App, repo: RepoRef, name: string): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'DELETE', path: `/tags/${encodePath(name)}`}, () => tagOf(s, repo.id, name) === undefined);
}

// ---- Releases ----

/** The pool's release (published), if any: a draft is in no group. */
const published = (s: Session, id: number) => s.data.pool.model('Release').get(id)?.data;

/** Creates a release; resolves with its id. A published one is in the pool when this resolves (or SYNC_WAIT_MS passed). */
export async function createRelease(app: App, repo: RepoRef, body: {tag_name: string; draft: boolean} & Record<string, unknown>): Promise<number> {
  const s = session(app);
  const w = await onlineWrite<ApiRelease>(app, {method: 'POST', api: 'v1', path: `${apiRepo(repo)}/releases`, body});
  const id = w.value?.id;
  if (typeof id !== 'number') throw new Error('Forgejo did not say which release it made.');
  if (body.draft) drafts(app).changed(repo);
  else await settle(app, repo.id, w.syncId, () => published(s, id)?.is_tag === false);
  return id;
}

/**
 * Edits a release (publishing a draft, or setting a release back to draft, with `draft`). Resolves once the pool
 * shows the result: a published release as edited, a draft gone from it.
 */
export async function editRelease(app: App, repo: RepoRef, id: number, body: {draft: boolean; name: string; prerelease: boolean} & Record<string, unknown>): Promise<void> {
  const s = session(app);
  await write(app, repo, {method: 'PATCH', path: `/releases/${String(id)}`, body}, () => {
    const r = published(s, id);
    return body.draft ? r === undefined || r.draft : r !== undefined && !r.draft && r.name === body.name && r.prerelease === body.prerelease;
  });
  drafts(app).changed(repo);
}

/** Deletes a release (its tag stays: a tag without a release). */
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

// ---- Drafts (API v1, cached) ----

export type DraftSlot =
  | {state: 'loading'}
  /** `stale`: the device's copy, while Forgejo is asked. */
  | {state: 'ready'; list: DraftRelease[]; stale: boolean}
  | {state: 'offline'}
  | {state: 'error'; message: string};

/** Asked again at most this often (the view opened twice in a row asks once). */
const FRESH_MS = 15_000;

const draftsKey = (repoId: number) => `drafts:${String(repoId)}`;

/** A session's draft releases per repository. */
export class Drafts {
  private readonly slots = observable.map<number, DraftSlot>({}, {deep: false});
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly asked = new Map<number, number>();
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** The repository's drafts (observable); what the memory cache has before the first load. */
  slot(repoId: number): DraftSlot {
    const s = this.slots.get(repoId);
    if (s) return s;
    const hit = codeSource(this.app)?.peek<DraftRelease[]>(draftsKey(repoId));
    return hit ? {state: 'ready', list: hit, stale: true} : {state: 'loading'};
  }

  /** One draft, if this device knows it. */
  find(repoId: number, pred: (d: DraftRelease) => boolean): DraftRelease | undefined {
    const s = this.slot(repoId);
    return s.state === 'ready' ? s.list.find(pred) : undefined;
  }

  /** Shows the cached list, then asks API v1 (once per FRESH_MS unless `force`). */
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
        this.set(repo.id, old ? {state: 'ready', list: old, stale: false} : {state: 'error', message: err instanceof Error ? err.message : String(err)});
      }
    })().finally(() => {
      this.inflight.delete(repo.id);
    });
    this.inflight.set(repo.id, p);
    return p;
  }

  /** A write changed the drafts: asked for again. */
  changed(repo: RepoRef): void {
    this.asked.delete(repo.id);
    void this.load(repo, true);
  }

  /** A draft deleted: it leaves the list at once. */
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

/** The session's drafts. */
export function drafts(app: App): Drafts {
  const s = session(app);
  let d = stores.get(s);
  if (!d) stores.set(s, d = new Drafts(app));
  return d;
}
