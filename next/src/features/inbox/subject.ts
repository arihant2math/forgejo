// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a notification is about when its issue is not on this device (a
// repository outside the workspace: a public one the viewer is not a member
// of, or one a site administrator can read): the notification row carries
// only ids. API v1 names it — the thread (title, repository, number) and the
// issue (its last activity, for the inbox's order) — asked once per
// notification and remembered on this device, so the row reads the same
// offline and after a reload. The server decides what the viewer may see: a
// thread it refuses stays "not on this device".

import {observable, runInAction} from 'mobx';
import {online} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import type {App} from '../../app/store.ts';
import type {Notification} from '../../protocol/types.gen.ts';

export interface Subject {
  title: string;
  owner: string;
  repo: string;
  number: number;
  pull: boolean;
  state: 'open' | 'closed' | 'merged';
  /** The issue's last activity (the inbox orders by it; the notification's time moves when it is read). */
  updated: string;
}

/** Notification id → its subject (null: the server would not say). */
const subjects = observable.map<number, Subject | null>({}, {deep: false});
const asked = new Set<number>();

const KEY = 'forgejo-next:subjects';
const KEEP = 200;

function load(userId: number): void {
  if (subjects.size || asked.size) return;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`${KEY}:${String(userId)}`) ?? '{}');
    if (!raw || typeof raw !== 'object') return;
    runInAction(() => {
      for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
        const s = v as Partial<Subject> | null;
        if (typeof s?.title === 'string' && typeof s.number === 'number' && typeof s.updated === 'string') subjects.set(Number(id), s as Subject);
      }
    });
  } catch {
    // Storage blocked: asked again online.
  }
}

function save(userId: number): void {
  try {
    const known = [...subjects].filter((e): e is [number, Subject] => e[1] !== null).slice(-KEEP);
    localStorage.setItem(`${KEY}:${String(userId)}`, JSON.stringify(Object.fromEntries(known)));
  } catch {
    // Storage blocked or full: kept for this tab only.
  }
}

interface ApiThread {
  subject?: {title?: unknown; url?: unknown; type?: unknown; state?: unknown};
  repository?: {name?: unknown; owner?: {login?: unknown}};
}

/** The subject of a thread (API v1 `GET /notifications/threads/{id}`), without its activity time. */
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

/** How many subjects are known (observed by the inbox's order, which reads them untracked). */
export function subjectsKnown(): number {
  return subjects.size;
}

/**
 * The subject of a notification whose issue is not in the pool (observes it); asks the server once (online)
 * when it is not known yet. undefined meanwhile, offline, or when the server would not say.
 */
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
      // Offline meanwhile, or refused: asked again in a later session.
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

/** The app path of a subject (its issue or pull request page). */
export function subjectPath(s: Subject): string {
  return `/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/${s.pull ? 'pulls' : 'issues'}/${String(s.number)}`;
}
