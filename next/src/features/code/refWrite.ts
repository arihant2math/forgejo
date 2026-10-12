// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {isSha, type RefKind, type RefTable} from '../../code/refs.ts';

export interface RefChoice {
  kind: RefKind;
  ref: string;
}

/** API v1 limits branch names and source refs to 100 characters. */
export const BRANCH_MAX = 100;
export const TAG_MAX = 255;
export const TITLE_MAX = 255;

/** Return a git/Forgejo naming or collision error, or undefined if valid. */
export function refNameProblem(name: string, what: 'branch' | 'tag', refs: RefTable): string | undefined {
  if (!name) return `A ${what} needs a name.`;
  if (name.length > (what === 'branch' ? BRANCH_MAX : TAG_MAX)) return `A ${what} name has ${String(what === 'branch' ? BRANCH_MAX : TAG_MAX)} characters at most.`;
  // eslint-disable-next-line no-control-regex -- git refuses control characters
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return 'Spaces and ~ ^ : ? * [ \\ are not allowed.';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'Slashes separate parts of the name: not at the start or the end, and one at a time.';
  if (name.split('/').some((part) => part.startsWith('.'))) return 'No part of the name can start with a dot.';
  if (name.includes('..')) return 'Two dots in a row are not allowed.';
  if (name.endsWith('.')) return 'The name cannot end with a dot.';
  if (name.split('/').some((part) => part.endsWith('.lock'))) return 'No part of the name can end with “.lock”.';
  if (name.includes('@{') || name === '@') return '“@{” and “@” alone are not allowed.';
  if (name.startsWith('-')) return 'The name cannot start with a dash.';
  if (what === 'branch' && name === 'HEAD') return '“HEAD” is not a branch name.';
  const table = what === 'branch' ? refs.branches : refs.tags;
  if (table.has(name)) return `A ${what} named “${name}” exists already.`;
  for (const other of table.keys()) {
    if (other.startsWith(`${name}/`) || name.startsWith(`${other}/`)) return `It clashes with the ${what} “${other}”: one name cannot be a ${what} and a folder of ${what === 'branch' ? 'branches' : 'tags'} both.`;
  }
  return undefined;
}

/** Use the SHA when branch/tag names collide, because git otherwise prefers the tag. */
export function refSpec(choice: RefChoice, refs: RefTable): string {
  if (choice.kind === 'commit') return choice.ref;
  const both = refs.branches.has(choice.ref) && refs.tags.has(choice.ref);
  if (!both) return choice.ref;
  return (choice.kind === 'branch' ? refs.branches.get(choice.ref) : refs.tags.get(choice.ref)) ?? choice.ref;
}

export function looksLikeSha(s: string): boolean {
  return isSha(s) || /^[0-9a-f]{7,63}$/.test(s);
}

export function createBranchBody(name: string, from: RefChoice, refs: RefTable): {new_branch_name: string; old_ref_name: string} {
  return {new_branch_name: name, old_ref_name: refSpec(from, refs)};
}

/** A nonblank message creates an annotated tag; otherwise the tag is lightweight. */
export function createTagBody(name: string, target: RefChoice, message: string, refs: RefTable): {tag_name: string; target: string; message: string} {
  return {tag_name: name, target: refSpec(target, refs), message: message.trim()};
}

export interface RepoState {
  archived: boolean;
  mirror: boolean;
}

/** Archived repos reject writes; mirrors reject ref writes; offline operations are never queued. */
export function writeBlock(repo: RepoState | undefined, online: boolean, action: string, refsOnly: boolean): string | undefined {
  if (repo?.archived) return 'This repository is archived: it takes no changes.';
  if (refsOnly && repo?.mirror) return 'This repository is a mirror: its branches and tags come from the remote.';
  if (!online) return `${action} needs a connection: it is not queued offline.`;
  return undefined;
}

export function branchDeleteBlock(name: string, defaultBranch: string, protectedBranch: boolean | undefined): string | undefined {
  if (name === defaultBranch) return 'The default branch cannot be deleted.';
  if (protectedBranch) return 'This branch is protected: Forgejo does not delete it. Its protection is in the repository’s settings.';
  return undefined;
}

export function tagDeleteBlock(hasRelease: boolean): string | undefined {
  return hasRelease ? 'This tag has a release: delete the release first, then the tag.' : undefined;
}

/** Unknown non-SHA targets remain branch names for server resolution. */
export function releaseTarget(target: string, refs: RefTable): RefChoice {
  if (refs.branches.has(target)) return {kind: 'branch', ref: target};
  if (refs.tags.has(target)) return {kind: 'tag', ref: target};
  if (looksLikeSha(target.toLowerCase())) return {kind: 'commit', ref: target.toLowerCase()};
  return {kind: 'branch', ref: target};
}

/** Commit choices retain their SHA as entered; unknown refs return undefined. */
export function targetCommit(choice: RefChoice, refs: RefTable): string | undefined {
  if (choice.kind === 'commit') return choice.ref;
  return (choice.kind === 'branch' ? refs.branches : refs.tags).get(choice.ref);
}

export interface ReleaseFields {
  tag: string;
  /** Ignored for existing tags. */
  target: string;
  title: string;
  notes: string;
  prerelease: boolean;
}

export interface KnownRelease {
  id: number;
  tag_name: string;
  is_tag: boolean;
}

/** The edited release's own tag is allowed; other releases cannot share it. */
export function releaseTagProblem(tag: string, refs: RefTable, releases: readonly KnownRelease[], editing?: number): string | undefined {
  if (!tag) return 'A release needs a tag.';
  const other = releases.find((r) => !r.is_tag && r.tag_name === tag && r.id !== editing);
  if (other) return `The tag “${tag}” has a release already.`;
  if (refs.tags.has(tag)) return undefined;
  return refNameProblem(tag, 'tag', refs);
}

/** Default an empty title to the tag, as Forgejo does. */
export function createReleaseBody(f: ReleaseFields, draft: boolean): {
  tag_name: string; target_commitish: string; name: string; body: string; draft: boolean; prerelease: boolean;
} {
  return {tag_name: f.tag.trim(), target_commitish: f.target, name: f.title.trim() || f.tag.trim(), body: f.notes, draft, prerelease: f.prerelease};
}

/** API v1 treats empty fields as unchanged: clear notes with a space, titles with the tag.
 * Published tags stay fixed; only drafts can change tag and target. */
export function editReleaseBody(f: ReleaseFields, was: {notes: string; draft: boolean}, draft: boolean): {
  tag_name?: string; target_commitish?: string; name: string; body: string; draft: boolean; prerelease: boolean;
} {
  const notes = f.notes === '' && was.notes !== '' ? ' ' : f.notes;
  return {
    ...(was.draft ? {tag_name: f.tag.trim(), target_commitish: f.target} : {}),
    name: f.title.trim() || f.tag.trim(), body: notes, draft, prerelease: f.prerelease,
  };
}

export interface DraftRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  prerelease: boolean;
  created_at: string;
  assets: DraftAsset[];
}

export interface DraftAsset {
  id: number;
  name: string;
  size: number;
  uuid: string;
  url: string;
}

export interface ApiRelease {
  id?: number;
  tag_name?: string;
  target_commitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string;
  assets?: {id?: number; name?: string; size?: number; uuid?: string; browser_download_url?: string}[] | null;
}

export function draftsOf(list: readonly ApiRelease[]): DraftRelease[] {
  return list.filter((r) => r.draft === true && typeof r.id === 'number' && r.tag_name).map((r) => ({
    id: r.id ?? 0, tag_name: r.tag_name ?? '', target_commitish: r.target_commitish ?? '', name: r.name ?? '', body: r.body ?? '',
    prerelease: r.prerelease === true, created_at: r.created_at ?? '',
    assets: (r.assets ?? []).filter((a) => typeof a.id === 'number').map((a) => ({
      id: a.id ?? 0, name: a.name ?? '', size: a.size ?? 0, uuid: a.uuid ?? '', url: a.browser_download_url ?? '',
    })),
  })).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}

/** POST multipart attachment; name overrides the filename. */
export function assetUploadPath(repoPath: string, releaseId: number, name: string): string {
  return `${repoPath}/releases/${String(releaseId)}/assets?${new URLSearchParams({name}).toString()}`;
}
