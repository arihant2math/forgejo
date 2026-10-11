// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The writes of the branches, tags and releases views, as pure functions
// (refWrite.test.ts): which names git takes (check-ref-format, as Forgejo's
// GitRefName binding checks them), why an action is not offered now, and
// the API v1 payloads. The requests themselves are refOps.ts.

import {isSha, type RefKind, type RefTable} from '../../code/refs.ts';

/** A branch, tag or commit chosen as the start of a new branch or tag. */
export interface RefChoice {
  kind: RefKind;
  /** The branch's or tag's name, or the commit's SHA (full or abbreviated). */
  ref: string;
}

/** API v1's `MaxSize(100)` on a new branch's name and on its source. */
export const BRANCH_MAX = 100;
/** A tag's name: the release table's column. */
export const TAG_MAX = 255;
/** A release's title (the release table's column). */
export const TITLE_MAX = 255;

/**
 * Why `name` cannot name a new branch or tag, in words, or undefined: git's check-ref-format (Forgejo's
 * IsValidRefPattern: no spaces, control characters or `~^:?*[\`, no `..`, `//`, `@{`, no component starting with
 * a dot, nothing ending in `/`, `.` or `.lock`), what git refuses for a branch (`HEAD`, a leading dash), and the
 * names taken here: one that exists, or one whose directory is a ref ("feature" and "feature/x" cannot both be).
 */
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

/**
 * What API v1 resolves a choice by (`old_ref_name`, a tag's `target`): the name, unless a branch and a tag share it
 * (git would take the tag) — then the commit the pool has for it. A commit is its SHA.
 */
export function refSpec(choice: RefChoice, refs: RefTable): string {
  if (choice.kind === 'commit') return choice.ref;
  const both = refs.branches.has(choice.ref) && refs.tags.has(choice.ref);
  if (!both) return choice.ref;
  return (choice.kind === 'branch' ? refs.branches.get(choice.ref) : refs.tags.get(choice.ref)) ?? choice.ref;
}

/** Whether a typed text can name a commit (a full or abbreviated SHA: 7 hex digits at least). */
export function looksLikeSha(s: string): boolean {
  return isSha(s) || /^[0-9a-f]{7,63}$/.test(s);
}

/** POST /repos/{owner}/{repo}/branches. */
export function createBranchBody(name: string, from: RefChoice, refs: RefTable): {new_branch_name: string; old_ref_name: string} {
  return {new_branch_name: name, old_ref_name: refSpec(from, refs)};
}

/** POST /repos/{owner}/{repo}/tags: a message makes it an annotated tag, none a lightweight one. */
export function createTagBody(name: string, target: RefChoice, message: string, refs: RefTable): {tag_name: string; target: string; message: string} {
  return {tag_name: name, target: refSpec(target, refs), message: message.trim()};
}

/** What the repository allows, for the reasons below. */
export interface RepoState {
  archived: boolean;
  mirror: boolean;
}

/**
 * Why a writer cannot do `action` now, or undefined: the repository is archived (Forgejo refuses every change),
 * a mirror's branches and tags come from its remote, and code operations need a connection (never queued).
 */
export function writeBlock(repo: RepoState | undefined, online: boolean, action: string, refsOnly: boolean): string | undefined {
  if (repo?.archived) return 'This repository is archived: it takes no changes.';
  if (refsOnly && repo?.mirror) return 'This repository is a mirror: its branches and tags come from the remote.';
  if (!online) return `${action} needs a connection: it is not queued offline.`;
  return undefined;
}

/** Why a branch cannot be deleted, as far as the device knows (Forgejo checks its protection rules too). */
export function branchDeleteBlock(name: string, defaultBranch: string, protectedBranch: boolean | undefined): string | undefined {
  if (name === defaultBranch) return 'The default branch cannot be deleted.';
  if (protectedBranch) return 'This branch is protected: Forgejo does not delete it. Its protection is in the repository’s settings.';
  return undefined;
}

/** Why a tag cannot be deleted here: a tag with a release goes with its release. */
export function tagDeleteBlock(hasRelease: boolean): string | undefined {
  return hasRelease ? 'This tag has a release: delete the release first, then the tag.' : undefined;
}

// ---- Releases ----

/** A release's form, as typed. */
export interface ReleaseFields {
  tag: string;
  /** The branch a new tag starts from (ignored for an existing tag). */
  target: string;
  title: string;
  notes: string;
  prerelease: boolean;
}

/** A release the form checks a tag against (published from the pool, drafts from API v1). */
export interface KnownRelease {
  id: number;
  tag_name: string;
  is_tag: boolean;
}

/**
 * Why a release cannot have this tag, or undefined: an existing tag is fine (unless another release has it), a new
 * one must be a valid name. `editing`: the release being edited (its own tag is fine).
 */
export function releaseTagProblem(tag: string, refs: RefTable, releases: readonly KnownRelease[], editing?: number): string | undefined {
  if (!tag) return 'A release needs a tag.';
  const other = releases.find((r) => !r.is_tag && r.tag_name === tag && r.id !== editing);
  if (other) return `The tag “${tag}” has a release already.`;
  if (refs.tags.has(tag)) return undefined;
  return refNameProblem(tag, 'tag', refs);
}

/** POST /repos/{owner}/{repo}/releases. The title defaults to the tag (as Forgejo's). */
export function createReleaseBody(f: ReleaseFields, draft: boolean): {
  tag_name: string; target_commitish: string; name: string; body: string; draft: boolean; prerelease: boolean;
} {
  return {tag_name: f.tag.trim(), target_commitish: f.target, name: f.title.trim() || f.tag.trim(), body: f.notes, draft, prerelease: f.prerelease};
}

/**
 * PATCH /repos/{owner}/{repo}/releases/{id}. API v1 keeps a field sent empty (it cannot tell "unchanged" from
 * "cleared"): notes cleared are sent as one space, which renders as nothing; a title cleared is the tag. A
 * published release keeps its tag (only a draft's tag and target change: its tag is made when it is published).
 */
export function editReleaseBody(f: ReleaseFields, was: {notes: string; draft: boolean}, draft: boolean): {
  tag_name?: string; target_commitish?: string; name: string; body: string; draft: boolean; prerelease: boolean;
} {
  const notes = f.notes === '' && was.notes !== '' ? ' ' : f.notes;
  return {
    ...(was.draft ? {tag_name: f.tag.trim(), target_commitish: f.target} : {}),
    name: f.title.trim() || f.tag.trim(), body: notes, draft, prerelease: f.prerelease,
  };
}

/** A draft release, from API v1 (drafts are not synced: B3 puts them in no group). */
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

/** API v1's release (the fields read here). */
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

/** API v1's drafts, newest first (anything that is not one is left out). */
export function draftsOf(list: readonly ApiRelease[]): DraftRelease[] {
  return list.filter((r) => r.draft === true && typeof r.id === 'number' && r.tag_name).map((r) => ({
    id: r.id ?? 0, tag_name: r.tag_name ?? '', target_commitish: r.target_commitish ?? '', name: r.name ?? '', body: r.body ?? '',
    prerelease: r.prerelease === true, created_at: r.created_at ?? '',
    assets: (r.assets ?? []).filter((a) => typeof a.id === 'number').map((a) => ({
      id: a.id ?? 0, name: a.name ?? '', size: a.size ?? 0, uuid: a.uuid ?? '', url: a.browser_download_url ?? '',
    })),
  })).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}

/** An asset's upload address (POST, multipart `attachment`; the name is the file's unless given). */
export function assetUploadPath(repoPath: string, releaseId: number, name: string): string {
  return `${repoPath}/releases/${String(releaseId)}/assets?${new URLSearchParams({name}).toString()}`;
}
