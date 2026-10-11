// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Opening a pull request from a comparison (pure): the title and description
// Forgejo proposes, whether the branches merge cleanly as far as the device
// can tell, the branches worth proposing, the request API v1 takes.

import type {CommitInfo} from '../../code/source.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {exclusiveScope} from '../issues/labels.ts';

/** Forgejo's longest issue title (models/issues: a title over it is cut, the rest goes to the description). */
export const TITLE_MAX = 255;

/**
 * The title and description a new pull request starts with, as Forgejo's compare page proposes them
 * (routers/web/repo/compare.go PrepareCompareDiff): one commit gives its summary and the rest of its message,
 * several the head branch's name. A title over TITLE_MAX is cut with an ellipsis, the rest opening the description.
 */
export function pullDefaults(commits: readonly Pick<CommitInfo, 'message'>[], total: number, head: string): {title: string; body: string} {
  let title = head;
  let body = '';
  const only = total === 1 ? commits[0] : undefined;
  if (only) {
    const lines = only.message.trim().split('\n');
    title = (lines[0] ?? '').trim();
    body = lines.slice(1).join('\n').trim();
  }
  // By code point (a cut never splits a character); Forgejo counts the column's characters.
  const chars = Array.from(title);
  if (chars.length > TITLE_MAX) {
    const cut = TITLE_MAX - 1;
    const rest = `…${chars.slice(cut).join('')}`;
    title = `${chars.slice(0, cut).join('')}…`;
    body = body ? `${rest}\n\n${body}` : rest;
  }
  return {title: title || head, body};
}

/** What the device can tell of merging head into base before Forgejo checks (it does once the pull request exists). */
export type MergeOutlook =
  /** Still loading the comparisons. */
  | {kind: 'checking'}
  /** The same commit: nothing to propose. */
  | {kind: 'identical'}
  /** Base has every commit of head already. */
  | {kind: 'up-to-date'}
  /** Head has commits, but together they change nothing. */
  | {kind: 'empty'}
  /** Merges cleanly: base has nothing head lacks (`behind` 0, a fast-forward), or the two sides change other files. */
  | {kind: 'clean'; behind: number}
  /** Both sides change these files since they diverged: Forgejo may find conflicts. */
  | {kind: 'overlap'; behind: number; files: string[]}
  /** Base moved on and its changes could not be read (offline, too large): Forgejo checks. */
  | {kind: 'unknown'; behind: number};

export interface OutlookInput {
  baseSha: string;
  headSha: string;
  /** Commits on head that base lacks (undefined: not loaded yet). */
  ahead: number | undefined;
  /** Commits on base that head lacks. */
  behind: number | undefined;
  /** The files head changes since the merge base (undefined: not loaded yet). */
  headFiles: readonly string[] | undefined;
  /** The files base changes since the merge base: undefined while loading, null when they cannot be read. */
  baseFiles: readonly string[] | null | undefined;
}

/** The merge outlook of a comparison from what is loaded so far. */
export function mergeOutlook(i: OutlookInput): MergeOutlook {
  if (i.baseSha === i.headSha) return {kind: 'identical'};
  if (i.ahead === undefined) return {kind: 'checking'};
  if (i.ahead === 0) return {kind: 'up-to-date'};
  if (i.headFiles === undefined) return {kind: 'checking'};
  if (i.headFiles.length === 0) return {kind: 'empty'};
  if (i.behind === undefined) return {kind: 'checking'};
  if (i.behind === 0) return {kind: 'clean', behind: 0};
  if (i.baseFiles === undefined) return {kind: 'checking'};
  if (i.baseFiles === null) return {kind: 'unknown', behind: i.behind};
  const theirs = new Set(i.baseFiles);
  const both = [...new Set(i.headFiles)].filter((f) => theirs.has(f)).sort();
  return both.length ? {kind: 'overlap', behind: i.behind, files: both} : {kind: 'clean', behind: i.behind};
}

/** Whether an outlook allows opening a pull request (Forgejo refuses one with nothing in it). */
export function proposable(o: MergeOutlook): boolean {
  return o.kind !== 'identical' && o.kind !== 'up-to-date';
}

/** A branch as the head chooser lists it. */
export interface BranchChoice {
  name: string;
  commitTime: string;
  pusherId: number;
}

/**
 * The branches to propose into `base`, most recently pushed first, the viewer's own pushes before the rest at the
 * same time; the base itself is not one.
 */
export function headChoices(branches: Iterable<BranchChoice>, base: string, me: number): BranchChoice[] {
  return [...branches].filter((b) => b.name !== base)
    .sort((a, b) => b.commitTime.localeCompare(a.commitTime) || Number(b.pusherId === me) - Number(a.pusherId === me) || a.name.localeCompare(b.name));
}

/** The labels chosen with `label` added or removed: an exclusive scoped label replaces its siblings, as Forgejo does. */
export function withLabel(chosen: readonly number[], label: Label, on: boolean, all: readonly Label[]): number[] {
  if (!on) return chosen.filter((x) => x !== label.id);
  if (chosen.includes(label.id)) return [...chosen];
  const scope = exclusiveScope(label);
  const keep = scope ? chosen.filter((x) => {
    const other = all.find((y) => y.id === x);
    return !other || exclusiveScope(other) !== scope;
  }) : chosen;
  return [...keep, label.id];
}

/** What the form holds when it is sent. */
export interface PullForm {
  base: string;
  head: string;
  title: string;
  body: string;
  labelIds: readonly number[];
  assignees: readonly string[];
  milestoneId: number;
}

/** API v1's CreatePullRequestOption for the form (POST /repos/{owner}/{repo}/pulls); reviewers are asked for after it. */
export function createPullBody(f: PullForm): Record<string, unknown> {
  return {
    base: f.base, head: f.head, title: f.title.trim(), body: f.body,
    ...(f.labelIds.length ? {labels: [...f.labelIds]} : {}),
    ...(f.assignees.length ? {assignees: [...f.assignees]} : {}),
    ...(f.milestoneId ? {milestone: f.milestoneId} : {}),
  };
}

/** The compare path of two sides (the code view's splat). */
export function compareSplat(base: string, head: string): string {
  return `compare/${base}...${head}`;
}

/** Whether a compare side names a fork's branch (`owner:branch`, `owner/repo:branch`): the classic page compares those. */
export function isForkHead(head: string): boolean {
  return head.includes(':');
}
