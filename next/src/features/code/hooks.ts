// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {compareStructural, computed, type IComputedValue} from 'mobx';
import {type Resource, useResource} from '../../app/resource.ts';
import {useApp} from '../../app/store.ts';
import {codeSource, type CodeSource} from '../../code/source.ts';
import type {RefTable} from '../../code/refs.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';

export function useSource(): CodeSource {
  const src = codeSource(useApp());
  if (!src) throw new Error('code views need a session');
  return src;
}

/** A read by immutable key: a Resource. */
export type Loaded<T> = Resource<T>;

/** Peek synchronously by immutable key, else load (the loader caches); an undefined key defers loading. */
export function useLoad<T>(key: string | undefined, peek: () => T | undefined, load: () => Promise<T>): Resource<T> {
  return useResource(key, () => load(), {peek, immutable: true});
}

export interface RefIndex extends RefTable {
  /** The default branch first, then by name. */
  branchNames: readonly string[];
  /** Newest version first. */
  tagNames: readonly string[];
}

function buildRefs(pool: Pool, repoId: number): RefIndex {
  const branches = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const b of pool.model('Branch').by('repo_id', repoId)) {
    if (!b.get('is_deleted')) branches.set(b.get('name'), b.get('commit_id'));
  }
  for (const r of pool.model('Release').by('repo_id', repoId)) {
    if (!r.get('draft') && r.get('sha')) tags.set(r.get('tag_name'), r.get('sha'));
  }
  const defaultBranch = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  const branchNames = [...branches.keys()].sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
  const tagNames = [...tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  return {branches, tags, defaultBranch, branchNames, tagNames};
}

const refIndexes = new WeakMap<Pool, Map<number, IComputedValue<RefIndex>>>();

/** One shared derivation per repository, so observers depend on it instead of on every branch and release. */
export function refTable(pool: Pool, repoId: number): RefIndex {
  let byRepo = refIndexes.get(pool);
  if (!byRepo) refIndexes.set(pool, byRepo = new Map<number, IComputedValue<RefIndex>>());
  let c = byRepo.get(repoId);
  if (!c) byRepo.set(repoId, c = computed(() => buildRefs(pool, repoId), {equals: compareStructural}));
  return c.get();
}

const branchMaps = new WeakMap<Pool, Map<number, IComputedValue<ReadonlyMap<string, Entity<'Branch'>>>>>();

/** Live branches by name. */
export function branchByName(pool: Pool, repoId: number): ReadonlyMap<string, Entity<'Branch'>> {
  let byRepo = branchMaps.get(pool);
  if (!byRepo) branchMaps.set(pool, byRepo = new Map<number, IComputedValue<ReadonlyMap<string, Entity<'Branch'>>>>());
  let c = byRepo.get(repoId);
  if (!c) {
    byRepo.set(repoId, c = computed(() => {
      const out = new Map<string, Entity<'Branch'>>();
      for (const b of pool.model('Branch').by('repo_id', repoId)) if (!b.get('is_deleted')) out.set(b.get('name'), b);
      return out;
    }, {equals: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)}));
  }
  return c.get();
}

/** Observes group membership to detect whether code refs are loaded. */
export function hasRefs(pool: Pool, repoId: number): boolean {
  return pool.model('Branch').by('repo_id', repoId).size > 0;
}

/** Reads a file and highlights it at idle priority in the code view's workers, ahead of its view. */
export function warmFile(src: CodeSource, base: string, repoId: number, sha: string, path: string, size?: number): void {
  void src.blob(repoId, sha, path, size).then(async (c) => {
    if (c.kind !== 'text') return;
    (await import('../../code/PierreProvider.tsx')).primeFile(base, sha, path, c.text);
  }).catch(() => undefined);
}
