// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The local search index's page side: one MiniSearch worker per session
// (workers/search.worker.ts, over Comlink), fed from the pool — every issue
// and pull request on this device in batches when it starts, then the
// changes the pool applies (coalesced, at most every 250 ms). Started the
// first time the palette opens (its chunk), so the boot route never pays
// for it.

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
  /** Round trip from the page (ms): posting the query, searching, the answer back. */
  rtt: number;
}

/** The worker's URL below this deployment's base (Vite writes it below its own build base). */
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
  /** What is indexed of each issue ("title\0number\0repo"): unchanged issues are not sent again. */
  private readonly indexed = new Map<number, string>();
  /** Repository names as indexed: only a rename re-indexes a repository's issues. */
  private readonly repoNames = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when the documents on this device when it started are indexed. */
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
          // A rename (not a star or a push): its issues' "owner/repo" changes.
          const name = (c.entity.data as Repository).full_name;
          const was = this.repoNames.get(c.id);
          // (First seen here: its issues may have been indexed without its name.)
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

  /** The issue's document, or undefined when what is indexed of it is unchanged. */
  private doc(i: Issue): SearchDoc | undefined {
    const d = {id: i.id, title: i.title, repo: this.repoName(i.repo_id), number: i.number};
    const key = `${d.title}\0${String(d.number)}\0${d.repo}`;
    if (this.indexed.get(i.id) === key) return undefined;
    this.indexed.set(i.id, key);
    return d;
  }

  private async loadAll(): Promise<void> {
    // Plain reads (no MobX tracking); documents are built and sent one batch at a time, the page breathing in between.
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
    // What the pool holds now decides (an issue added and removed within one batch is removed).
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

  /** Searches the index (after the initial load). */
  async search(query: string, limit = 20): Promise<LocalAnswer> {
    await this.ready;
    const t0 = performance.now();
    const a = await this.api.search(query, limit);
    const rtt = performance.now() - t0;
    try {
      performance.measure('search:local', {start: t0, end: t0 + rtt, detail: {worker: a.ms, size: a.size, hits: a.hits.length}});
    } catch {
      // No User Timing.
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

/** The session's local search index, started on first use. */
export function localSearch(app: App): LocalSearch | undefined {
  const s = app.session;
  if (!s || typeof Worker === 'undefined') return undefined;
  let ix = indexes.get(s);
  if (!ix) indexes.set(s, ix = new LocalSearch(app, s));
  return ix;
}
