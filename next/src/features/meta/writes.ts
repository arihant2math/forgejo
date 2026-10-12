// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only metadata writes stay optimistic until the echoed sync id arrives,
// preventing flicker back to stale pool rows. Failures roll back with a notice.

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

/** null deletes a row; seq prevents an older response from settling a newer edit. */
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

/** Apply pending edits and deletions; include created rows only for repoId. */
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

/** Observe pending label changes for this repository. */
export function viewLabels(rows: Iterable<Label>, repoId: number): Label[] {
  return mergePending(rows, pending.Label.edits, pending.Label.created.values(), repoId);
}

/** Observe pending milestone changes for this repository. */
export function viewMilestones(rows: Iterable<Milestone>, repoId: number): Milestone[] {
  return mergePending(rows, pending.Milestone.edits, pending.Milestone.created.values(), repoId);
}

export function isPending(model: 'Label' | 'Milestone', id: number): boolean {
  return id < 0 || pending[model].edits.has(id);
}

export interface RepoRef {
  owner: string;
  repo: string;
  repoId: number;
}

const api = (r: RepoRef, rest: string) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}${rest}`;

const CONFIRM_MS = 15_000;

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
