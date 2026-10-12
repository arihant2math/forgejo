// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export type RefKind = 'branch' | 'tag' | 'commit';

export type CodeRoute =
  /** A directory or a file at a ref (no ref: the default branch). `blame`: the file's blame. */
  | {view: 'src' | 'blame' | 'commits'; kind?: RefKind; rest: string[]}
  | {view: 'commit'; sha: string}
  | {view: 'branches' | 'tags' | 'releases' | 'actions'}
  /** A writer's release form (Forgejo's `releases/new`, `releases/edit/{tag}`): `tag` undefined for a new release. */
  | {view: 'release-form'; tag: string | undefined}
  /** `base`/`head` "": the default branch (`compare`, `compare/{head}`); `head` may name a fork's branch (`owner:branch`). */
  | {view: 'compare'; base: string; head: string}
  /** `job`: the job's index in the run, -1 when the URL names none (the view picks one). */
  | {view: 'run'; run: number; job: number};

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Full SHAs only: abbreviations are not immutable addresses. */
export function isSha(s: string): boolean {
  return SHA.test(s);
}

const ABBREVIATION = /^[0-9a-f]{4,63}$/i;

/** Recognizes abbreviated commit URLs; full() substitutes a resolved SHA in the same path. */
export function abbreviatedCommit(splat: string): {abbreviation: string; full: (sha: string) => string} | undefined {
  const segs = splat.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '.' || s === '..')) return undefined;
  const at = segs[0] === 'commit' && segs.length === 2 ? 1 :
    (segs[0] === 'src' || segs[0] === 'blame' || segs[0] === 'commits') && segs[1] === 'commit' && segs.length >= 3 ? 2 : -1;
  const abbreviation = segs[at];
  if (at < 0 || abbreviation === undefined || !ABBREVIATION.test(abbreviation) || isSha(abbreviation)) return undefined;
  return {
    abbreviation: abbreviation.toLowerCase(),
    full: (sha) => [...segs.slice(0, at), sha, ...segs.slice(at + 1)].join('/'),
  };
}

/** Legacy code URLs use a trailing sentinel to distinguish paths from build assets. */
export const END = '-';

/** Strips exactly one trailing legacy sentinel, preserving a file's own "-" segment. */
export function legacyCodeSplat(splat: string): string {
  const segs = splat.split('/').filter((s) => s !== '');
  if (segs.at(-1) === END) segs.pop();
  return segs.join('/');
}

export function codeRestOf(params: {view?: string | undefined; _splat?: string | undefined}): string {
  return [params.view ?? '', params._splat ?? ''].join('/').replace(/^\/+|\/+$/g, '');
}

/** The code route's params for a code path (codeRestOf's inverse). */
export function codeParams(rest: string): {view: string; _splat: string} {
  const path = rest.replace(/^\/+|\/+$/g, '');
  const at = path.indexOf('/');
  return at < 0 ? {view: path, _splat: ''} : {view: path.slice(0, at), _splat: path.slice(at + 1)};
}

/** Parses the part of a code URL after `/{owner}/{repo}/` (the router's decoded splat). */
export function parseCodePath(splat: string): CodeRoute | undefined {
  const segs = splat.split('/').filter((s) => s !== '');
  // Dot segments can escape the repository or endpoint during URL normalization.
  if (segs.some((s) => s === '.' || s === '..')) return undefined;
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
    case 'releases':
      if (rest.length === 0) return {view: head};
      if (rest[0] === 'new' && rest.length === 1) return {view: 'release-form', tag: undefined};
      // A tag's name may have slashes ("release/1.0").
      return rest[0] === 'edit' && rest.length > 1 ? {view: 'release-form', tag: rest.slice(1).join('/')} : undefined;
    case 'branches':
    case 'tags':
    case 'actions':
      return rest.length === 0 ? {view: head} : head === 'actions' ? parseRun(rest) : undefined;
    case 'compare':
      return parseCompare(rest.join('/'));
  }
  return undefined;
}

/** Empty sides mean the default branch; direct comparisons and downloads stay on classic pages. */
function parseCompare(spec: string): CodeRoute | undefined {
  if (spec === '') return {view: 'compare', base: '', head: ''};
  const at = spec.indexOf('...');
  const [base, head] = at < 0 ? ['', spec] : [spec.slice(0, at), spec.slice(at + 3)];
  if ((at >= 0 && (!base || !head)) || base.includes('..') || head.includes('..') || /\.(?:diff|patch)$/.test(head)) return undefined;
  return {view: 'compare', base, head};
}

function parseRun(rest: string[]): CodeRoute | undefined {
  // Run numbers are repository-local; jobs are indices. The view shows the latest attempt.
  if (rest[0] !== 'runs' || !rest[1] || !/^[1-9]\d{0,15}$/.test(rest[1])) return undefined;
  if (rest.length === 2) return {view: 'run', run: Number(rest[1]), job: -1};
  const job = rest[2] === 'jobs' && rest[3] && /^\d{1,6}$/.test(rest[3]) ? Number(rest[3]) : undefined;
  if (job === undefined) return undefined;
  if (rest.length === 4 || (rest.length === 6 && rest[4] === 'attempt' && /^[1-9]\d{0,5}$/.test(rest[5] ?? ''))) return {view: 'run', run: Number(rest[1]), job};
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

export interface RefTable {
  branches: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
  defaultBranch: string;
}

/** Slash-containing refs use the longest known prefix; undefined means the ref is absent from the pool. */
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

export function shortSha(sha: string): string {
  return sha.slice(0, 10);
}
