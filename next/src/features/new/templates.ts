// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The instance's templates for a new repository's first commit and labels:
// API v1 GET /gitignore/templates, /licenses and /label/templates. Forgejo
// reads them from its options at start, so they change only with a restart:
// kept in the code cache (IndexedDB) and shown from there at once — offline
// too — then asked again once per session when online.

import {observable, runInAction} from 'mobx';
import {online} from '../../app/api.ts';
import type {App, Session} from '../../app/store.ts';
import {CodeCache} from '../../code/cache.ts';

export interface RepoTemplates {
  gitignores: readonly string[];
  licenses: readonly string[];
  labels: readonly string[];
}

/** The cache key (repository 0: no repository's content; purged with nothing). */
const KEY = 'templates:0:new-repo';

/** The lists as last known (observable): undefined until the cache or Forgejo answered. */
export const repoTemplates = observable.box<RepoTemplates | undefined>(undefined, {deep: false});

/** Per session: its database's cache, and whether Forgejo was asked. */
const sessions = new WeakMap<Session, {cache: CodeCache; asked: boolean}>();

/** Reads the cached lists, and asks Forgejo once per session (online). */
export function loadRepoTemplates(app: App): void {
  const s = app.session;
  if (!s) return;
  let st = sessions.get(s);
  if (!st) sessions.set(s, st = {cache: new CodeCache(s.data.db), asked: false});
  const state = st;
  const c = st.cache;
  if (!repoTemplates.get()) {
    void c.get<RepoTemplates>(KEY).then((v) => {
      if (v && !repoTemplates.get()) set(v);
    });
  }
  if (state.asked || !navigator.onLine) return;
  state.asked = true;
  void Promise.all([
    online(app, {api: 'v1', path: '/gitignore/templates'}),
    online(app, {api: 'v1', path: '/licenses'}),
    online(app, {api: 'v1', path: '/label/templates'}),
  ]).then(([g, l, t]) => {
    const v = parseTemplates(g, l, t);
    set(v);
    c.put(KEY, v);
  }, () => {
    state.asked = false;
  });
}

function set(v: RepoTemplates): void {
  runInAction(() => {
    repoTemplates.set(v);
  });
}

/** API v1's answers as lists of names (licenses: their keys); anything else is an empty list. */
export function parseTemplates(gitignores: unknown, licenses: unknown, labels: unknown): RepoTemplates {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
  const keys = Array.isArray(licenses) ? licenses.map((x: unknown) => (x && typeof x === 'object' ? (x as {key?: unknown}).key : undefined)).filter((k): k is string => typeof k === 'string' && k !== '') : [];
  return {gitignores: names(gitignores), licenses: keys, labels: names(labels)};
}
