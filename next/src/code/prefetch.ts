// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Prefetch requested reviews for offline use, throttled per user across tabs.
// Skip hidden pages and data-saving connections.

import {untracked} from 'mobx';
import {sitePath} from '../app/config.ts';
import type {App} from '../app/store.ts';
import {filePath, parseDiff} from './diff.ts';
import {type Lang, langOf} from './lang.ts';
import {fetchCommits, poolCommits, pullOf} from './pull.ts';
import {codeSource} from './source.ts';

const EVERY = 15 * 60_000;
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

async function loaded(app: App, group: string, ms: number): Promise<void> {
  const s = app.session;
  if (!s) return;
  const until = Date.now() + ms;
  while (Date.now() < until && untracked(() => s.data.pool.groupEntities(group).size === 0)) await new Promise((r) => setTimeout(r, 250));
}

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
    // Released issue groups remain available offline as recent groups.
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
      // Mark only completed runs; metadata checks avoid loading cached bodies.
      const done = `prefetched:${String(pr.base_repo_id)}:${c.base}:${c.head}`;
      const had = await src.hasDiff(pr.base_repo_id, c.base, c.head);
      // The diff may be evicted before its completion marker.
      if (had && await src.cache.has(done)) continue;
      const files = parseDiff(await src.diffText(pr.base_repo_id, c.base, c.head));
      if (!had) report.diffs++;
      let bytes = 0;
      const langs = new Set<Lang>();
      for (const f of files.slice(0, MAX_FILES)) {
        if (signal?.aborted || f.binary || f.status === 'deleted') continue;
        // The base repository holds head objects via refs/pull/N/head.
        const entry = await src.entry(pr.base_repo_id, c.head, filePath(f));
        if (entry?.type !== 'blob') continue;
        const content = await src.blob(pr.base_repo_id, entry.sha, filePath(f), entry.size);
        const lang = langOf(filePath(f));
        if (lang && content.kind === 'text') langs.add(lang);
        bytes += content.size;
        report.files++;
        if (bytes > MAX_BYTES) break;
      }
      // Cache grammar chunks for offline highlighting.
      for (const lang of langs) await src.warm(lang).catch(() => undefined);
      if (!signal?.aborted) src.cache.put(done, true);
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
  // Allow initial sync to catch up before prefetching.
  setTimeout(run, 15_000);
  const timer = setInterval(run, 60_000);
}

const started = new WeakSet<object>();
