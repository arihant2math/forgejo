// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Resolve notification subjects outside the workspace through API v1 and cache for offline use.
// Server-denied threads remain unresolved.

import {observable, runInAction} from 'mobx';
import {online} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {readJson, writeJson} from '../../app/storage.ts';
import type {App} from '../../app/store.ts';
import type {Notification} from '../../protocol/types.gen.ts';

export interface Subject {
  title: string;
  owner: string;
  repo: string;
  number: number;
  pull: boolean;
  state: 'open' | 'closed' | 'merged';
  /** Activity timestamp; reading changes notification time but not subject activity. */
  updated: string;
}

/** Notification id to subject; null means the server could not resolve it. */
const subjects = observable.map<number, Subject | null>({}, {deep: false});
const asked = new Set<number>();

const KEY = 'forgejo-next:subjects';
const KEEP = 200;

function load(userId: number): void {
  if (subjects.size || asked.size) return;
  const raw = readJson(`${KEY}:${String(userId)}`);
  if (!raw || typeof raw !== 'object') return;
  runInAction(() => {
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as Partial<Subject> | null;
      if (typeof s?.title === 'string' && typeof s.number === 'number' && typeof s.updated === 'string') subjects.set(Number(id), s as Subject);
    }
  });
}

function save(userId: number): void {
  const known = [...subjects].filter((e): e is [number, Subject] => e[1] !== null).slice(-KEEP);
  writeJson(`${KEY}:${String(userId)}`, Object.fromEntries(known));
}

interface ApiThread {
  subject?: {title?: unknown; url?: unknown; type?: unknown; state?: unknown};
  repository?: {name?: unknown; owner?: {login?: unknown}};
}

export function parseThread(t: ApiThread | undefined): Omit<Subject, 'updated'> | undefined {
  const s = t?.subject;
  const owner = t?.repository?.owner?.login;
  const repo = t?.repository?.name;
  const num = typeof s?.url === 'string' ? /\/(?:issues|pulls)\/(\d+)$/.exec(s.url)?.[1] : undefined;
  if (typeof s?.title !== 'string' || typeof owner !== 'string' || typeof repo !== 'string' || !num) return undefined;
  const state = s.state === 'closed' || s.state === 'merged' ? s.state : 'open';
  return {title: s.title, owner, repo, number: Number(num), pull: s.type === 'Pull', state};
}

/** The subject known for a notification (observes it; never asks the server). */
export function knownSubject(app: App, id: number): Subject | undefined {
  if (app.session) load(app.session.userId);
  return subjects.get(id) ?? undefined;
}

/** Observe the subject count so untracked ordering updates when subjects arrive. */
export function subjectsKnown(): number {
  return subjects.size;
}

/** Observe the subject and fetch once online if unknown. Undefined while pending, offline or denied. */
export function subjectOf(app: App, n: Notification): Subject | undefined {
  const s = app.session;
  if (!s || (n.subject !== 'issue' && n.subject !== 'pull')) return undefined;
  load(s.userId);
  const known = subjects.get(n.id);
  if (known !== undefined || asked.has(n.id) || !connectivity.online) return known ?? undefined;
  asked.add(n.id);
  void (async () => {
    let value: Subject | null = null;
    try {
      const thread = parseThread(await online<ApiThread>(app, {api: 'v1', path: `/notifications/threads/${String(n.id)}`}));
      if (thread) {
        const issue = await online<{updated_at?: unknown}>(app, {
          api: 'v1', path: `/repos/${encodeURIComponent(thread.owner)}/${encodeURIComponent(thread.repo)}/issues/${String(thread.number)}`,
        }).catch(() => undefined);
        value = {...thread, updated: typeof issue?.updated_at === 'string' ? new Date(issue.updated_at).toISOString() : n.created_at};
      }
    } catch {
      asked.delete(n.id);
      return;
    }
    runInAction(() => {
      subjects.set(n.id, value);
    });
    save(s.userId);
  })();
  return undefined;
}

export function subjectPath(s: Subject): string {
  return `/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/${s.pull ? 'pulls' : 'issues'}/${String(s.number)}`;
}
