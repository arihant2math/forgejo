// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Writing a repository's labels and milestones: online only (PLAN §5.4 —
// the intents queue issue and pull request metadata, not the repository's
// own), through API v1, with an optimistic view: the change shows at once,
// stays until the pool holds Forgejo's answer (the echoed sync id, so it
// never flickers back), and is rolled back with a notice when Forgejo
// refuses it or cannot be reached.

import {observable, runInAction} from 'mobx';
import {failureText, onlineWrite, type OnlineRequest} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {App} from '../../app/store.ts';
import type {Label, Milestone} from '../../protocol/types.gen.ts';
import {type LabelDraft, normalizeColor} from './labels.ts';
import {dueOnOf, type MilestoneDraft} from './milestones.ts';

/** A row's changed fields (undefined: the field is cleared — a due date, an archive date). */
type Patch<T> = {[K in keyof T]?: T[K] | undefined};

/** A pending change of one row: a patch, or null for a deletion; `seq` tells a later change of the same row from it. */
interface Edit<T> {
  patch: Patch<T> | null;
  seq: number;
}

interface PendingRows<T extends {id: number}> {
  edits: Map<number, Edit<T>>;
  /** Rows created here and not in the pool yet (negative ids). */
  created: Map<number, T>;
}

const pendingOf = <T extends {id: number}>(): PendingRows<T> => ({edits: observable.map(), created: observable.map()});

const pending = {Label: pendingOf<Label>(), Milestone: pendingOf<Milestone>()};

let seq = 0;
let tempIds = 0;

/**
 * Rows as the user sees them (pure): each changed row patched, deleted ones left out, created ones added.
 * `repoId` keeps the created rows of other repositories out.
 */
export function mergePending<T extends {id: number; repo_id: number}>(rows: Iterable<T>, edits: ReadonlyMap<number, {patch: Patch<T> | null}>, created: Iterable<T>, repoId: number): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const e = edits.get(r.id);
    if (e?.patch === null) continue;
    out.push(e ? {...r, ...e.patch} : r);
  }
  for (const c of created) if (c.repo_id === repoId) out.push(c);
  return out;
}

/** A repository's labels (its own) as the user sees them; observes the pending changes. */
export function viewLabels(rows: Iterable<Label>, repoId: number): Label[] {
  return mergePending(rows, pending.Label.edits, pending.Label.created.values(), repoId);
}

/** A repository's milestones as the user sees them; observes the pending changes. */
export function viewMilestones(rows: Iterable<Milestone>, repoId: number): Milestone[] {
  return mergePending(rows, pending.Milestone.edits, pending.Milestone.created.values(), repoId);
}

/** Whether a row has a change on its way (its row shows it as pending). */
export function isPending(model: 'Label' | 'Milestone', id: number): boolean {
  return id < 0 || pending[model].edits.has(id);
}

/** The repository a write goes to: its route's names, and its id (its sync group). */
export interface RepoRef {
  owner: string;
  repo: string;
  repoId: number;
}

const api = (r: RepoRef, rest: string) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}${rest}`;

/** How long the optimistic row waits for the pool to hold Forgejo's answer (then the pool's row shows anyway). */
const CONFIRM_MS = 15_000;

/**
 * Sends one write: shows it (`apply`) unless offline, then waits for the pool to hold Forgejo's answer and drops
 * the optimistic part (`settle`); on a failure drops it at once and says why. Answers Forgejo's reply, or undefined.
 */
async function write<T>(app: App, r: RepoRef, what: string, req: OnlineRequest, apply: () => void, settle: () => void): Promise<T | undefined> {
  if (!connectivity.online) {
    notify(app, {tone: 'neutral', title: onlineOnly(what)});
    return undefined;
  }
  runInAction(apply);
  try {
    const {value, syncId} = await onlineWrite<T>(app, req);
    const data = app.session?.data;
    if (syncId !== undefined && data) {
      await Promise.race([
        data.whenSynced(`repo:${String(r.repoId)}`, syncId, AbortSignal.timeout(CONFIRM_MS)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CONFIRM_MS)),
      ]);
    }
    runInAction(settle);
    return value ?? ({} as T);
  } catch (err) {
    runInAction(settle);
    notify(app, {tone: 'danger', title: `${what} failed`, description: failureText(err)});
    return undefined;
  }
}

/** Puts a row's pending change in place; returns how to drop it again (unless a later change replaced it). */
function edit<T extends {id: number}>(rows: PendingRows<T>, id: number, patch: Patch<T> | null): {apply: () => void; settle: () => void} {
  const mine = ++seq;
  return {
    apply: () => {
      const before = rows.edits.get(id);
      rows.edits.set(id, {patch: patch && before?.patch ? {...before.patch, ...patch} : patch, seq: mine});
    },
    settle: () => {
      if (rows.edits.get(id)?.seq === mine) rows.edits.delete(id);
    },
  };
}

// ── Labels ────────────────────────────────────────────────────────────────

function labelBody(d: LabelDraft) {
  return {name: d.name.trim(), color: normalizeColor(d.color) ?? d.color, description: d.description, exclusive: d.exclusive, is_archived: d.archived};
}

export async function createLabel(app: App, r: RepoRef, d: LabelDraft): Promise<boolean> {
  const id = --tempIds;
  const body = labelBody(d);
  const row: Label = {
    id, repo_id: r.repoId, org_id: 0, name: body.name, color: body.color, description: body.description, exclusive: body.exclusive,
    num_issues: 0, num_closed_issues: 0, created_at: new Date().toISOString(), ...(d.archived ? {archived_at: new Date().toISOString()} : {}),
  };
  const done = await write(app, r, `Creating the label “${body.name}”`, {method: 'POST', api: 'v1', path: api(r, '/labels'), body}, () => {
    pending.Label.created.set(id, row);
  }, () => {
    pending.Label.created.delete(id);
  });
  return done !== undefined;
}

export async function editLabel(app: App, r: RepoRef, label: Label, change: Record<string, string | boolean>): Promise<boolean> {
  const patch: Patch<Label> = {};
  if (typeof change.name === 'string') patch.name = change.name;
  if (typeof change.color === 'string') patch.color = change.color;
  if (typeof change.description === 'string') patch.description = change.description;
  if (typeof change.exclusive === 'boolean') patch.exclusive = change.exclusive;
  if (typeof change.is_archived === 'boolean') patch.archived_at = change.is_archived ? new Date().toISOString() : undefined;
  const e = edit(pending.Label, label.id, patch);
  const done = await write(app, r, `Saving the label “${label.name}”`, {method: 'PATCH', api: 'v1', path: api(r, `/labels/${String(label.id)}`), body: change}, e.apply, e.settle);
  return done !== undefined;
}

export async function deleteLabel(app: App, r: RepoRef, label: Label): Promise<boolean> {
  const e = edit(pending.Label, label.id, null);
  const done = await write(app, r, `Deleting the label “${label.name}”`, {method: 'DELETE', api: 'v1', path: api(r, `/labels/${String(label.id)}`)}, e.apply, e.settle);
  return done !== undefined;
}

// ── Milestones ────────────────────────────────────────────────────────────

/** Creates a milestone; answers its id (Forgejo's), or undefined when it failed. */
export async function createMilestone(app: App, r: RepoRef, d: MilestoneDraft): Promise<number | undefined> {
  const id = --tempIds;
  const now = new Date().toISOString();
  const body = {title: d.title.trim(), description: d.description, ...(d.due ? {due_on: dueOnOf(d.due)} : {})};
  const row: Milestone = {
    id, repo_id: r.repoId, title: body.title, description: body.description, state: 'open', open_issues: 0, closed_issues: 0,
    created_at: now, updated_at: now, ...(body.due_on ? {due_on: body.due_on} : {}),
  };
  const done = await write<{id?: unknown}>(app, r, `Creating the milestone “${body.title}”`, {method: 'POST', api: 'v1', path: api(r, '/milestones'), body}, () => {
    pending.Milestone.created.set(id, row);
  }, () => {
    pending.Milestone.created.delete(id);
  });
  return typeof done?.id === 'number' ? done.id : undefined;
}

/** What a milestone's edit changes (API v1's EditMilestoneOption). */
export interface MilestoneChange {
  title?: string;
  description?: string;
  /** "YYYY-MM-DD", or "" to clear it. */
  due?: string;
  state?: 'open' | 'closed';
}

export async function editMilestone(app: App, r: RepoRef, m: Milestone, change: MilestoneChange, what = `Saving the milestone “${m.title}”`): Promise<boolean> {
  const body: Record<string, string> = {};
  const patch: Patch<Milestone> = {updated_at: new Date().toISOString()};
  if (change.title !== undefined) body.title = patch.title = change.title.trim();
  if (change.description !== undefined) body.description = patch.description = change.description;
  if (change.due !== undefined) {
    body.due_on = dueOnOf(change.due);
    patch.due_on = change.due ? body.due_on : undefined;
  }
  if (change.state !== undefined) {
    body.state = patch.state = change.state;
    patch.closed_at = change.state === 'closed' ? new Date().toISOString() : undefined;
  }
  const e = edit(pending.Milestone, m.id, patch);
  const done = await write(app, r, what, {method: 'PATCH', api: 'v1', path: api(r, `/milestones/${String(m.id)}`), body}, e.apply, e.settle);
  return done !== undefined;
}

export async function deleteMilestone(app: App, r: RepoRef, m: Milestone): Promise<boolean> {
  const e = edit(pending.Milestone, m.id, null);
  const done = await write(app, r, `Deleting the milestone “${m.title}”`, {method: 'DELETE', api: 'v1', path: api(r, `/milestones/${String(m.id)}`)}, e.apply, e.settle);
  return done !== undefined;
}
