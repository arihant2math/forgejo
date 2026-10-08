// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Background prefetch for offline review (PLAN §5.5): pull requests awaiting
// the viewer's review get their conversation (the lazy issue group, kept as a
// recent group), their diff and their changed files at the head into this
// device, so they can be read and reviewed offline and the review submitted
// when the connection is back. Runs when the page is idle, online, on a
// connection that does not ask to save data, at most every 15 minutes per
// user across tabs, in a module loaded only then (not on the boot route).

import {untracked} from 'mobx';
import {sitePath} from '../app/config.ts';
import type {App} from '../app/store.ts';
import {filePath} from './diff.ts';
import {fetchCommits, poolCommits, pullOf} from './pull.ts';
import {codeSource} from './source.ts';

const EVERY = 15 * 60_000;
/** Pull requests per run; changed files and their bytes per pull request. */
const MAX_PULLS = 15;
const MAX_FILES = 40;
const MAX_BYTES = 4 * 1024 * 1024;

export interface PrefetchReport {
  pulls: number[];
  diffs: number;
  files: number;
}

/** A function: TypeScript would narrow a plain read across the awaits. */
function isOnline(): boolean {
  return navigator.onLine;
}

function saveData(): boolean {
  const c = (navigator as Navigator & {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
  return Boolean(c?.saveData) || c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g';
}

/** The ids of open pull requests that request the viewer's review (API v1 issue search; online). */
async function reviewRequested(app: App): Promise<number[]> {
  const s = app.session;
  if (!s) return [];
  const token = await s.auth.token();
  const q = new URLSearchParams({type: 'pulls', state: 'open', review_requested: 'true', limit: String(MAX_PULLS), page: '1'});
  const res = await fetch(sitePath(app.config, `/api/v1/repos/issues/search?${q.toString()}`), {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  return (await res.json() as {id?: unknown}[]).map((i) => i.id).filter((id): id is number => typeof id === 'number');
}

/** Waits until a group's entities are in the pool (or the time is up). */
async function loaded(app: App, group: string, ms: number): Promise<void> {
  const s = app.session;
  if (!s) return;
  const until = Date.now() + ms;
  while (Date.now() < until && untracked(() => s.data.pool.groupEntities(group).size === 0)) await new Promise((r) => setTimeout(r, 250));
}

/** One run: what it fetched (already-cached content costs nothing). */
export async function prefetchReviews(app: App, signal?: AbortSignal): Promise<PrefetchReport> {
  const report: PrefetchReport = {pulls: [], diffs: 0, files: 0};
  const s = app.session;
  const src = codeSource(app);
  if (!s || !src || !navigator.onLine) return report;
  const pool = s.data.pool;
  for (const issueId of await reviewRequested(app)) {
    if (signal?.aborted || !isOnline()) break;
    const issue = untracked(() => pool.model('Issue').get(issueId)?.data);
    if (!issue) continue; // a repository not on this device
    // The conversation: holding the issue group loads it; released, it stays on this device as a recent group.
    const group = `issue:${String(issueId)}`;
    s.data.hold(group);
    try {
      await loaded(app, group, 10_000);
    } finally {
      s.data.release(group);
    }
    const pr = untracked(() => pullOf(pool, issueId));
    if (!pr) continue;
    const c = untracked(() => poolCommits(pool, pr, issue.state === 'open')) ?? await fetchCommits(app, src, pr);
    if (!c) continue;
    report.pulls.push(issueId);
    try {
      const had = await src.hasDiff(pr.base_repo_id, c.base, c.head);
      const files = await src.diff(pr.base_repo_id, c.base, c.head);
      if (!had) report.diffs++;
      let bytes = 0;
      for (const f of files.slice(0, MAX_FILES)) {
        if (signal?.aborted || f.binary || f.status === 'deleted') continue;
        // What the file view reads: the head's tree entry, then the blob by its SHA (the base repository has
        // the head's objects: refs/pull/N/head).
        const entry = await src.entry(pr.base_repo_id, c.head, filePath(f));
        if (entry?.type !== 'blob') continue;
        const content = await src.blob(pr.base_repo_id, entry.sha, filePath(f), entry.size);
        bytes += content.size;
        report.files++;
        if (bytes > MAX_BYTES) break;
      }
    } catch {
      // Next pull request (an unreadable head repository, a dropped connection).
    }
  }
  return report;
}

/** Starts the periodic prefetch for this page (idempotent). */
export function startPrefetch(app: App): void {
  const s = app.session;
  if (!s || started.has(s)) return;
  started.add(s);
  const key = `forgejo-next:prefetch:${String(s.userId)}`;
  const run = () => {
    // Signed out (or another user) since: stop.
    if (app.session !== s) {
      clearInterval(timer);
      return;
    }
    if (!navigator.onLine || saveData() || document.visibilityState !== 'visible') return;
    try {
      const last = Number(localStorage.getItem(key) ?? 0);
      if (Date.now() - last < EVERY) return;
      localStorage.setItem(key, String(Date.now()));
    } catch {
      // No storage: run anyway (this tab only).
    }
    void prefetchReviews(app).catch(() => undefined);
  };
  // The first run once the session had time to catch up; then a check every minute (runs every 15).
  setTimeout(run, 15_000);
  const timer = setInterval(run, 60_000);
}

const started = new WeakSet<object>();
