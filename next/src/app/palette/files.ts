// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Use the cached default-branch tree so file search also works offline after the tree is loaded.

import {useEffect, useMemo, useState} from 'react';
import {codeSource} from '../../code/source.ts';
import type {App} from '../store.ts';
import {score} from './search.ts';

interface Tree {
  owner: string;
  repo: string;
  ref: string;
  paths: readonly string[];
  /** Lower-cased once per tree, not per keystroke. */
  lower: readonly string[];
  names: readonly string[];
}

/** The repository's file paths at its default branch's head (undefined: unknown here, offline, or refused). */
function treeOf(app: App, repoId: number): Promise<Tree | undefined> {
  const s = app.session;
  const r = s?.data.pool.model('Repository').get(repoId)?.data;
  const src = codeSource(app);
  if (!s || !r || !src) return Promise.resolve(undefined);
  const branch = [...s.data.pool.model('Branch').by('repo_id', repoId)].find((b) => b.get('name') === r.default_branch && !b.get('is_deleted'));
  const sha = branch?.get('commit_id');
  if (!sha) return Promise.resolve(undefined);
  return src.paths(repoId, sha).then((t) => {
    const lower = t.paths.map((p) => p.toLowerCase());
    return {owner: r.owner_name, repo: r.name, ref: r.default_branch, paths: t.paths, lower, names: lower.map((p) => p.slice(p.lastIndexOf('/') + 1))};
  }, () => undefined);
}

export interface FileHit {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  score: number;
}

function pathScore(lower: string, name: string, words: readonly string[]): number {
  const inName = score(name, words);
  if (inName >= 0) return inName * 2;
  return score(lower, words);
}

/** Empty until the repository tree loads. */
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
  const key = words.join(' ');
  return useMemo(() => {
    if (!want || !t) return [];
    const w = key.split(' ');
    const hits: FileHit[] = [];
    for (let i = 0; i < t.paths.length; i++) {
      const s = pathScore(t.lower[i] ?? '', t.names[i] ?? '', w);
      if (s >= 0) hits.push({owner: t.owner, repo: t.repo, ref: t.ref, path: t.paths[i] ?? '', score: s});
    }
    return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
  }, [want, t, key, limit]);
}
