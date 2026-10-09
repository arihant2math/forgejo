// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Saved views (PLAN §7.1): a list page with its filters, grouping and
// ordering, under a name — the viewer's issues or pull requests, or a
// repository's. Kept per user on this device (localStorage, one key with
// the user's id; cleared at sign-out like the other LOCAL_PREFS) and shared
// by the tabs (the `storage` event). Syncing them through the server is for
// later (the tracker: "local, synced later").

import {observable, runInAction} from 'mobx';
import {listSearch, type ListSearch, myListSearch} from '../../app/search.ts';
import {LOCAL_PREFS} from '../../app/splash.ts';
import {uuid} from '../../intents/intents.ts';

const KEY = LOCAL_PREFS[2];
const MAX = 100;

export interface SavedView {
  id: string;
  name: string;
  /** The list's site path: "/issues", "/pulls", "/{owner}/{repo}/issues", "/{owner}/{repo}/pulls". */
  path: string;
  /** Its search params (the list's view). */
  search: ListSearch & {type?: string};
}

/** Whether a path is a list page a view can be saved on (and only those: a stored view never navigates elsewhere). */
export function isListPath(path: string): boolean {
  return /^\/(?:issues|pulls)$/.test(path) || /^\/(?!-\/)[^/?#]+\/[^/?#]+\/(?:issues|pulls)$/.test(path);
}

/** A stored view, checked (storage is shared with whatever else runs on the origin). */
export function parseView(v: unknown): SavedView | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.path !== 'string' || !isListPath(o.path)) return undefined;
  const raw = o.search && typeof o.search === 'object' ? o.search as Record<string, unknown> : {};
  const search = /^\/(?:issues|pulls)$/.test(o.path) ? myListSearch(raw) : listSearch(raw);
  const name = o.name.trim().slice(0, 80);
  return name ? {id: o.id, name, path: o.path, search} : undefined;
}

function read(userId: number): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {user?: unknown; views?: unknown} | null;
    if (v?.user !== userId || !Array.isArray(v.views)) return [];
    return v.views.map(parseView).filter((x) => x !== undefined).slice(0, MAX);
  } catch {
    return [];
  }
}

export class ViewStore {
  readonly views = observable.array<SavedView>([], {deep: false});
  /** The view the list on screen was opened from (a sidebar or palette pick): the list says when it changed. */
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
    try {
      localStorage.setItem(KEY, JSON.stringify({user: this.userId, views}));
    } catch {
      // Storage blocked: kept for this page only.
    }
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

  remove(id: string): void {
    this.write(read(this.userId).filter((v) => v.id !== id));
  }

  /** The view now shows this search (its list's filters, grouping and ordering as they are). */
  update(id: string, search: SavedView['search']): void {
    this.write(read(this.userId).map((v) => (v.id === id ? parseView({...v, search}) ?? v : v)));
  }

  open(id: string): void {
    runInAction(() => {
      this.opened.set(id);
    });
  }

  /** The saved view that is exactly this page and search, if any. */
  match(path: string, search: SavedView['search']): SavedView | undefined {
    const key = canonical(search);
    return this.views.find((v) => v.path === path && canonical(v.search) === key);
  }
}

/** A search's identity regardless of key order and empty values. */
export function canonical(search: object): string {
  return JSON.stringify(Object.entries(search).filter(([, v]) => v !== undefined && v !== '').sort(([a], [b]) => a.localeCompare(b)));
}

const stores = new Map<number, ViewStore>();

/** The signed-in user's saved views. */
export function viewStore(userId: number): ViewStore {
  let s = stores.get(userId);
  if (!s) stores.set(userId, s = new ViewStore(userId));
  return s;
}
