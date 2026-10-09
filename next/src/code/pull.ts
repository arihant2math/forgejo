// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A pull request's two commits (PLAN §5.7): the diff is (merge base, head).
// Both come from the pool when it can: the synced PullRequest's merge_base
// and the head branch's commit (Branch, synced with the head repository).
// A head the pool does not have (a fork outside the workspace, AGit) is
// asked of API v1 once and kept as a hint — the only mutable value in the
// code cache, replaced whenever it is asked again online.

import {untracked} from 'mobx';
import type {App} from '../app/store.ts';
import {online, RequestFailed} from '../app/api.ts';
import type {Pool} from '../data/pool.ts';
import type {PullRequest} from '../protocol/types.gen.ts';
import {isSha} from './refs.ts';
import type {CodeSource} from './source.ts';

export interface PullCommits {
  base: string;
  head: string;
  /** Where the head came from: the synced branch, or a hint fetched from API v1 (maybe stale offline). */
  from: 'pool' | 'hint';
}

/** The pull request of an issue (observes the issue's PullRequest). */
export function pullOf(pool: Pool, issueId: number): PullRequest | undefined {
  for (const e of pool.model('PullRequest').by('issue_id', issueId)) return e.data;
  return undefined;
}

/** The head branch's commit from the pool (observes the head repository's branches), or undefined. */
export function poolHead(pool: Pool, pr: PullRequest): string | undefined {
  if (pr.flow !== 0) return undefined; // AGit: no branch row
  for (const b of pool.model('Branch').by('repo_id', pr.head_repo_id)) {
    if (b.data.name === pr.head_branch && !b.data.is_deleted && isSha(b.data.commit_id)) return b.data.commit_id;
  }
  return undefined;
}

/**
 * (merge base, head) from the pool, or undefined when the pool lacks one of
 * them. Only for an open pull request: Forgejo stops following the head
 * branch once one is merged or closed (refs/pull/N/head stays where it was),
 * so the branch may have moved on since — those ask API v1 (`fetchCommits`).
 */
export function poolCommits(pool: Pool, pr: PullRequest, open: boolean): PullCommits | undefined {
  if (!open || pr.merged) return undefined;
  const head = poolHead(pool, pr);
  return head && isSha(pr.merge_base) ? {base: pr.merge_base, head, from: 'pool'} : undefined;
}

const hintKey = (pr: PullRequest) => `prhead:${String(pr.base_repo_id)}:${String(pr.id)}`;

/**
 * The commits from API v1 (online: asked again and stored as the hint), else
 * the stored hint, else undefined.
 */
export async function fetchCommits(app: App, src: CodeSource, pr: PullRequest): Promise<PullCommits | undefined> {
  const repo = untracked(() => app.session?.data.pool.model('Repository').get(pr.base_repo_id)?.data);
  if (repo && navigator.onLine) {
    try {
      const j = await online<{head?: {sha?: string}; merge_base?: string}>(app, {
        api: 'v1', path: `/repos/${encodeURIComponent(repo.owner_name)}/${encodeURIComponent(repo.name)}/pulls/${String(pr.number)}`, timeout: 10_000,
      });
      const head = j?.head?.sha ?? '';
      const base = j?.merge_base ?? pr.merge_base;
      if (isSha(head) && isSha(base)) {
        const c: PullCommits = {base, head, from: 'hint'};
        src.cache.put(hintKey(pr), c);
        return c;
      }
    } catch (err) {
      // Gone or not readable: say so (no stale hint). Unreachable: fall back to the hint.
      if (err instanceof RequestFailed && (err.status === 403 || err.status === 404)) throw err;
    }
  }
  return src.cache.get<PullCommits>(hintKey(pr));
}
