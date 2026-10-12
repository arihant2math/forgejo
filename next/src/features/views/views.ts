// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Views are device-local, keyed by user, cleared at sign-out, and shared across tabs via storage events.

import {readJson, STORAGE_PREFIX, writeJson} from '../../app/storage.ts';
import {observable, runInAction} from 'mobx';
import {inboxSearch, type InboxSearch, listSearch, type ListSearch, myListSearch} from '../../app/search.ts';
import {uuid} from '../../intents/intents.ts';

const KEY = `${STORAGE_PREFIX}views`;
const MAX = 100;

export interface SavedView {
  id: string;
  name: string;
  path: string;
  search: (ListSearch & {type?: string}) | InboxSearch;
}

/** Restrict stored-view navigation to supported list pages. */
export function isListPath(path: string): boolean {
  return path === '/notifications' || /^\/(?:issues|pulls)$/.test(path) || /^\/(?!-\/)[^/?#]+\/[^/?#]+\/(?:issues|pulls)$/.test(path);
}

/** Treat origin-shared storage as untrusted and validate each view. */
export function parseView(v: unknown): SavedView | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.path !== 'string' || !isListPath(o.path)) return undefined;
  const raw = o.search && typeof o.search === 'object' ? o.search as Record<string, unknown> : {};
  const search = o.path === '/notifications' ? inboxSearch(raw) : /^\/(?:issues|pulls)$/.test(o.path) ? myListSearch(raw) : listSearch(raw);
  const name = o.name.trim().slice(0, 80);
  return name ? {id: o.id, name, path: o.path, search} : undefined;
}

function read(userId: number): SavedView[] {
  const raw = readJson(KEY);
  if (!raw || typeof raw !== 'object') return [];
  const v = raw as {user?: unknown; views?: unknown};
  if (v.user !== userId || !Array.isArray(v.views)) return [];
  return v.views.map(parseView).filter((x) => x !== undefined).slice(0, MAX);
}

export class ViewStore {
  readonly views = observable.array<SavedView>([], {deep: false});
  /** Source view for the active list; the list reports when it changes. */
  readonly opened = observable.box<string | undefined>(undefined);
  private readonly userId: number;

  constructor(userId: number) {
    this.userId = userId;
    this.views.replace(read(userId));
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === KEY || e.key === null) this.reload();
      });
    }
  }

  reload(): void {
    const next = read(this.userId);
    runInAction(() => {
      this.views.replace(next);
    });
  }

  private write(views: SavedView[]): void {
    runInAction(() => {
      this.views.replace(views);
    });
    writeJson(KEY, {user: this.userId, views});
  }

  save(name: string, path: string, search: SavedView['search']): SavedView | undefined {
    const view = parseView({id: uuid(), name, path, search});
    if (!view) return undefined;
    this.write([...read(this.userId), view].slice(-MAX));
    return view;
  }

  rename(id: string, name: string): void {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    this.write(read(this.userId).map((v) => (v.id === id ? {...v, name: n} : v)));
  }

  /** Returns an Undo that puts the same view (same id) back at its place. */
  remove(id: string): () => void {
    const views = read(this.userId);
    const at = views.findIndex((v) => v.id === id);
    const view = views[at];
    this.write(views.filter((v) => v.id !== id));
    return () => {
      const now = read(this.userId);
      if (!view || now.some((v) => v.id === id)) return;
      // A full list drops its newest view, never the one put back (at < MAX), and read() caps the same way.
      this.write(now.toSpliced(at, 0, view).slice(0, MAX));
    };
  }

  update(id: string, search: SavedView['search']): void {
    this.write(read(this.userId).map((v) => (v.id === id ? parseView({...v, search}) ?? v : v)));
  }

  open(id: string): void {
    runInAction(() => {
      this.opened.set(id);
    });
  }

  match(path: string, search: SavedView['search']): SavedView | undefined {
    const key = canonical(search);
    return this.views.find((v) => v.path === path && canonical(v.search) === key);
  }
}

/** Ignore key order and empty values when comparing searches. */
export function canonical(search: object): string {
  return JSON.stringify(Object.entries(search).filter(([, v]) => v !== undefined && v !== '').sort(([a], [b]) => a.localeCompare(b)));
}

const stores = new Map<number, ViewStore>();

export function viewStore(userId: number): ViewStore {
  let s = stores.get(userId);
  if (!s) stores.set(userId, s = new ViewStore(userId));
  return s;
}
