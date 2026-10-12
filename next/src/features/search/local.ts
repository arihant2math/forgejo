// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Start the session's worker on palette use to keep it out of boot; batch pool changes to avoid blocking the page.

import {type Remote, wrap} from 'comlink';
import {untracked} from 'mobx';
import {appWorkerURL} from '../../app/trusted.ts';
import type {App, Session} from '../../app/store.ts';
import type {Pool} from '../../data/pool.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';
import type {SearchAnswer, SearchApi, SearchDoc} from '../../workers/search.worker.ts';
import workerUrl from '../../workers/search.worker.ts?worker&url';

const BATCH = 5000;
const FLUSH_MS = 250;

export interface LocalAnswer extends SearchAnswer {
  /** Full page-to-worker round trip, in ms. */
  rtt: number;
}

/** Respect the deployment base used by Vite for worker assets. */
function workerPath(app: App): string {
  const at = workerUrl.indexOf('assets/');
  return at >= 0 ? `${app.config.base}${workerUrl.slice(at)}` : workerUrl;
}

export class LocalSearch {
  private readonly api: Remote<SearchApi>;
  private readonly worker: Worker;
  private readonly pool: Pool;
  private readonly peek: ReadonlyMap<number, Repository>;
  private readonly off: () => void;
  private pendingUpsert = new Set<number>();
  private pendingRemove = new Set<number>();
  /** Indexed fingerprints prevent resending unchanged issues. */
  private readonly indexed = new Map<number, string>();
  /** Repository renames require reindexing their issues. */
  private readonly repoNames = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves after the initial local documents are indexed. */
  readonly ready: Promise<void>;
  size = 0;

  constructor(app: App, s: Session) {
    this.pool = s.data.pool;
    this.peek = s.data.peek('Repository');
    this.worker = new Worker(appWorkerURL(app.config.base, workerPath(app)), {type: 'module', name: 'search'});
    this.api = wrap<SearchApi>(this.worker);
    this.off = this.pool.onApplied((changes) => {
      for (const c of changes) {
        if (c.model === 'Issue') {
          if (c.entity) this.pendingUpsert.add(c.id);
          else this.pendingRemove.add(c.id);
        } else if (c.model === 'Repository' && c.entity) {
          const name = (c.entity.data as Repository).full_name;
          const was = this.repoNames.get(c.id);
          // Issues may already be indexed without a repository name.
          if (was === name) continue;
          this.repoNames.set(c.id, name);
          for (const e of untracked(() => [...this.pool.model('Issue').by('repo_id', c.id)])) this.pendingUpsert.add(e.id);
        }
      }
      this.schedule();
    });
    this.ready = this.loadAll();
  }

  private repoName(id: number): string {
    let n = this.repoNames.get(id);
    if (n === undefined) {
      n = this.pool.model('Repository').get(id)?.data.full_name ?? this.peek.get(id)?.full_name ?? '';
      if (n) this.repoNames.set(id, n);
    }
    return n;
  }

  private doc(i: Issue): SearchDoc | undefined {
    const d = {id: i.id, title: i.title, repo: this.repoName(i.repo_id), number: i.number};
    const key = `${d.title}\0${String(d.number)}\0${d.repo}`;
    if (this.indexed.get(i.id) === key) return undefined;
    this.indexed.set(i.id, key);
    return d;
  }

  private async loadAll(): Promise<void> {
    // Avoid MobX tracking and yield between batches so indexing does not block the page.
    const all = untracked(() => [...this.pool.model('Issue').all()]);
    for (let i = 0; i < all.length; i += BATCH) {
      const docs = all.slice(i, i + BATCH).map((e) => this.doc(e.data)).filter((d) => d !== undefined);
      this.size = await this.api.upsert(docs);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_MS);
  }

  private async flush(): Promise<void> {
    await this.ready;
    const ids = new Set([...this.pendingUpsert, ...this.pendingRemove]);
    this.pendingUpsert = new Set();
    this.pendingRemove = new Set();
    // Read final pool state: an item added then removed within the batch must stay removed.
    const issues = this.pool.model('Issue');
    const docs: SearchDoc[] = [];
    const rm: number[] = [];
    untracked(() => {
      for (const id of ids) {
        const d = issues.get(id)?.data;
        if (d) {
          const doc = this.doc(d);
          if (doc) docs.push(doc);
        } else if (this.indexed.delete(id)) rm.push(id);
      }
    });
    if (docs.length) this.size = await this.api.upsert(docs);
    if (rm.length) this.size = await this.api.remove(rm);
  }

  /** Wait for the initial load before searching. */
  async search(query: string, limit = 20): Promise<LocalAnswer> {
    await this.ready;
    const t0 = performance.now();
    const a = await this.api.search(query, limit);
    const rtt = performance.now() - t0;
    try {
      performance.measure('search:local', {start: t0, end: t0 + rtt, detail: {worker: a.ms, size: a.size, hits: a.hits.length}});
    } catch {
      // User Timing is optional.
    }
    return {...a, rtt};
  }

  close(): void {
    this.off();
    clearTimeout(this.timer);
    this.worker.terminate();
  }
}

const indexes = new WeakMap<Session, LocalSearch>();

export function localSearch(app: App): LocalSearch | undefined {
  const s = app.session;
  if (!s || typeof Worker === 'undefined') return undefined;
  let ix = indexes.get(s);
  if (!ix) indexes.set(s, ix = new LocalSearch(app, s));
  return ix;
}
