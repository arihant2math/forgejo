// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {CommitInfo} from '../../code/source.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {exclusiveScope} from '../issues/labels.ts';

/** Forgejo issue-title character limit; overflow becomes description text. */
export const TITLE_MAX = 255;

/** Match Forgejo compare defaults: one commit uses its message, otherwise the head name; truncate long titles. */
export function pullDefaults(commits: readonly Pick<CommitInfo, 'message'>[], total: number, head: string): {title: string; body: string} {
  let title = head;
  let body = '';
  const only = total === 1 ? commits[0] : undefined;
  if (only) {
    const lines = only.message.trim().split('\n');
    title = (lines[0] ?? '').trim();
    body = lines.slice(1).join('\n').trim();
  }
  // Count code points like Forgejo; never split a character.
  const chars = Array.from(title);
  if (chars.length > TITLE_MAX) {
    const cut = TITLE_MAX - 1;
    const rest = `…${chars.slice(cut).join('')}`;
    title = `${chars.slice(0, cut).join('')}…`;
    body = body ? `${rest}\n\n${body}` : rest;
  }
  return {title: title || head, body};
}

export type MergeOutlook =
  | {kind: 'checking'}
  | {kind: 'identical'}
  | {kind: 'up-to-date'}
  | {kind: 'empty'}
  | {kind: 'clean'; behind: number}
  /** File overlap is only a potential conflict; Forgejo performs the merge check. */
  | {kind: 'overlap'; behind: number; files: string[]}
  /** Base changes are unreadable; defer the check to Forgejo. */
  | {kind: 'unknown'; behind: number};

export interface OutlookInput {
  baseSha: string;
  headSha: string;
  /** Undefined while loading. */
  ahead: number | undefined;
  behind: number | undefined;
  /** Paths changed since the merge base; undefined while loading. */
  headFiles: readonly string[] | undefined;
  /** Paths changed since the merge base; undefined while loading, null if unreadable. */
  baseFiles: readonly string[] | null | undefined;
}

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

export function proposable(o: MergeOutlook): boolean {
  return o.kind !== 'identical' && o.kind !== 'up-to-date';
}

export interface BranchChoice {
  name: string;
  commitTime: string;
  pusherId: number;
}

/** Exclude base; sort newest pushes first, breaking ties in favor of the viewer. */
export function headChoices(branches: Iterable<BranchChoice>, base: string, me: number): BranchChoice[] {
  return [...branches].filter((b) => b.name !== base)
    .sort((a, b) => b.commitTime.localeCompare(a.commitTime) || Number(b.pusherId === me) - Number(a.pusherId === me) || a.name.localeCompare(b.name));
}

/** Exclusive scoped labels replace their selected siblings. */
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

export interface PullForm {
  base: string;
  head: string;
  title: string;
  body: string;
  labelIds: readonly number[];
  assignees: readonly string[];
  milestoneId: number;
}

/** Reviewers require separate requests after pull-request creation. */
export function createPullBody(f: PullForm): Record<string, unknown> {
  return {
    base: f.base, head: f.head, title: f.title.trim(), body: f.body,
    ...(f.labelIds.length ? {labels: [...f.labelIds]} : {}),
    ...(f.assignees.length ? {assignees: [...f.assignees]} : {}),
    ...(f.milestoneId ? {milestone: f.milestoneId} : {}),
  };
}

export function compareSplat(base: string, head: string): string {
  return `compare/${base}...${head}`;
}

export function isForkHead(head: string): boolean {
  return head.includes(':');
}

/** Include forkRepo when owners match to disambiguate the fork from its upstream. */
export function forkHead(forkOwner: string, forkRepo: string, upstreamOwner: string, branch: string): string {
  return forkOwner.toLowerCase() === upstreamOwner.toLowerCase() ? `${forkOwner}/${forkRepo}:${branch}` : `${forkOwner}:${branch}`;
}

export function typedForkHead(query: string): string | undefined {
  const q = query.trim();
  return /^[\w.-]+(?:\/[\w.-]+)?:[^\s:]+$/.test(q) ? q : undefined;
}
