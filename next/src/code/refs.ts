// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code URLs and refs (PLAN §3): everything below `/-/next/code/{owner}/{repo}/`
// mirrors Forgejo's own URL shapes (`src/branch/main/dir/file`,
// `commit/<sha>`, `compare/a...b`, …), so the canonical URL is the same path
// without the prefix. The only mutable step, ref → SHA, is answered from the
// synced Branch and Release (tag) entities: offline too, and never stale
// beyond the pool. Pure.

export type RefKind = 'branch' | 'tag' | 'commit';

export type CodeRoute =
  /** A directory or a file at a ref (no ref: the default branch). `blame`: the file's blame. */
  | {view: 'src' | 'blame' | 'commits'; kind?: RefKind; rest: string[]}
  | {view: 'commit'; sha: string}
  | {view: 'branches' | 'tags' | 'releases' | 'actions'}
  | {view: 'compare'; base: string; head: string}
  | {view: 'run'; run: number; job: number};

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A full commit SHA (B9 refuses anything else: abbreviations are not immutable addresses). */
export function isSha(s: string): boolean {
  return SHA.test(s);
}

/**
 * The last segment of every code URL the UI makes: the server takes a path
 * below the UI's base ending in "name.ext" for a build file (404), and a file
 * or a ref ("v1.2") would end so. Exactly one final END is dropped when parsing.
 */
export const END = '-';

/** A code path with its END segment. */
export function withEnd(splat: string): string {
  return `${splat.replace(/\/+$/, '')}/${END}`;
}

/** Parses the part of a code URL after `/-/next/code/{owner}/{repo}/` (the router's decoded splat). */
export function parseCodePath(splat: string): CodeRoute | undefined {
  const segs = splat.split('/').filter((s) => s !== '');
  if (segs.at(-1) === END) segs.pop();
  const [head, ...rest] = segs;
  switch (head) {
    case undefined:
      return {view: 'src', rest: []};
    case 'src':
    case 'blame':
    case 'commits': {
      const kind = rest[0];
      if (kind === 'branch' || kind === 'tag' || kind === 'commit') return {view: head, kind, rest: rest.slice(1)};
      if (rest.length) return undefined;
      return {view: head, rest: []};
    }
    case 'commit':
      return rest.length === 1 && rest[0] && isSha(rest[0]) ? {view: 'commit', sha: rest[0]} : undefined;
    case 'branches':
    case 'tags':
    case 'releases':
    case 'actions':
      return rest.length === 0 ? {view: head} : head === 'actions' ? parseRun(rest) : undefined;
    case 'compare': {
      const spec = rest.join('/');
      const at = spec.indexOf('...');
      if (at <= 0 || at + 3 >= spec.length) return undefined;
      return {view: 'compare', base: spec.slice(0, at), head: spec.slice(at + 3)};
    }
  }
  return undefined;
}

function parseRun(rest: string[]): CodeRoute | undefined {
  // runs/<number>[/jobs/<index>] (Forgejo's: the run's number in the repository, the job's index in the run).
  if (rest[0] !== 'runs' || !rest[1] || !/^[1-9]\d{0,15}$/.test(rest[1])) return undefined;
  if (rest.length === 2) return {view: 'run', run: Number(rest[1]), job: 0};
  if (rest.length === 4 && rest[2] === 'jobs' && rest[3] && /^\d{1,6}$/.test(rest[3])) return {view: 'run', run: Number(rest[1]), job: Number(rest[3])};
  return undefined;
}

export interface Resolved {
  kind: RefKind;
  /** The ref's name (the SHA for a commit). */
  ref: string;
  sha: string;
  /** The path inside the repository ("" for the root). */
  path: string;
}

/** What the pool knows: branch and tag names → commit SHA. */
export interface RefTable {
  branches: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
  defaultBranch: string;
}

/**
 * The ref and path a URL names. Branch and tag names may contain slashes:
 * the longest prefix that names one wins (Forgejo does the same). undefined
 * when the ref is unknown here (not synced yet, deleted, or offline and
 * never seen).
 */
export function resolveRef(refs: RefTable, kind: RefKind | undefined, rest: readonly string[]): Resolved | undefined {
  if (kind === undefined) {
    const sha = refs.branches.get(refs.defaultBranch);
    return sha ? {kind: 'branch', ref: refs.defaultBranch, sha, path: rest.join('/')} : undefined;
  }
  if (kind === 'commit') {
    const [sha, ...path] = rest;
    return sha && isSha(sha) ? {kind, ref: sha, sha, path: path.join('/')} : undefined;
  }
  const table = kind === 'branch' ? refs.branches : refs.tags;
  for (let n = rest.length; n > 0; n--) {
    const name = rest.slice(0, n).join('/');
    const sha = table.get(name);
    if (sha) return {kind, ref: name, sha, path: rest.slice(n).join('/')};
  }
  return undefined;
}

/** The splat of a code URL (pass as the route's `_splat`; the router encodes it). */
export function codeSplat(view: 'src' | 'blame' | 'commits', r: Pick<Resolved, 'kind' | 'ref'>, path = ''): string {
  return [view, r.kind, r.ref, ...(path ? [path] : [])].join('/');
}

/** The SHA a compare side names: a branch, a tag or a full SHA. */
export function resolveName(refs: RefTable, name: string): string | undefined {
  if (isSha(name)) return name;
  return refs.branches.get(name) ?? refs.tags.get(name);
}

/** The parent directory of a path ("" for a top-level entry). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** "abcdef1" for display (SHAs stay full everywhere else). */
export function shortSha(sha: string): string {
  return sha.slice(0, 10);
}
