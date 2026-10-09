// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The ⌘K palette's files: the paths of the repository on screen (or the
// last one opened) at its default branch, from API v1's recursive tree
// (online; asked once per commit and kept in memory for the session), found
// by name first, then by path.

import {useEffect, useState} from 'react';
import {online} from '../api.ts';
import type {App} from '../store.ts';
import {score} from './search.ts';

interface Tree {
  /** owner/name, for the links. */
  owner: string;
  repo: string;
  ref: string;
  paths: string[];
}

const trees = new Map<string, Promise<Tree | undefined>>();

/** The repository's file paths at its default branch's head (undefined: unknown here, offline, or refused). */
function treeOf(app: App, repoId: number): Promise<Tree | undefined> {
  const s = app.session;
  const r = s?.data.pool.model('Repository').get(repoId)?.data;
  if (!s || !r) return Promise.resolve(undefined);
  const branch = [...s.data.pool.model('Branch').by('repo_id', repoId)].find((b) => b.get('name') === r.default_branch && !b.get('is_deleted'));
  const sha = branch?.get('commit_id');
  if (!sha) return Promise.resolve(undefined);
  const key = `${String(repoId)}:${sha}`;
  let p = trees.get(key);
  if (!p) {
    p = online<{tree?: {path: string; type: string}[]}>(app, {
      api: 'v1', path: `/repos/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}/git/trees/${sha}?recursive=true&per_page=10000`,
    }).then((t) => ({owner: r.owner_name, repo: r.name, ref: r.default_branch, paths: (t?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path)}), () => {
      trees.delete(key);
      return undefined;
    });
    trees.set(key, p);
  }
  return p;
}

export interface FileHit {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  score: number;
}

/** Scores a path: the file's name counts double (a name match beats a directory's). */
function pathScore(path: string, words: readonly string[]): number {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const inName = score(name, words);
  if (inName >= 0) return inName * 2;
  return score(lower, words);
}

/** The files matching the query in the repository (empty until its tree is here). */
export function useFiles(app: App, repoId: number, query: string, limit = 6): FileHit[] {
  const [tree, setTree] = useState<{repoId: number; tree: Tree | undefined}>({repoId: 0, tree: undefined});
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const want = repoId > 0 && words.length > 0 && words.join('').length >= 2;
  useEffect(() => {
    if (!want || tree.repoId === repoId) return undefined;
    let live = true;
    void treeOf(app, repoId).then((t) => {
      if (live) setTree({repoId, tree: t});
    });
    return () => {
      live = false;
    };
  }, [app, repoId, want, tree.repoId]);
  const t = tree.repoId === repoId ? tree.tree : undefined;
  if (!want || !t) return [];
  const hits: FileHit[] = [];
  for (const path of t.paths) {
    const s = pathScore(path, words);
    if (s >= 0) hits.push({owner: t.owner, repo: t.repo, ref: t.ref, path, score: s});
  }
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
}
