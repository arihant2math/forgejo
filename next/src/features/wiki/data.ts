// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Wiki data is not synced: cache by repository/page and revalidate on access.
// Render through Forgejo for wiki-relative links; reuse unchanged page/sidebar renderings.

import {observable, runInAction} from 'mobx';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {CodeCache} from '../../code/cache.ts';
import {codeSource} from '../../code/source.ts';
import type {APIMarkupRequest, APIMarkupResponse} from '../../protocol/types.gen.ts';
import {decodeContent, encodeContent, FOOTER, pageOfSubUrl, SIDEBAR} from './paths.ts';

interface ApiWikiCommit {
  sha: string;
  author?: {name?: string; email?: string; date?: string} | null;
  message?: string;
}

interface ApiWikiMeta {
  title: string;
  sub_url: string;
  last_commit?: ApiWikiCommit | null;
}

interface ApiWikiPage extends ApiWikiMeta {
  content_base64?: string;
  commit_count?: number;
  sidebar?: string;
  footer?: string;
}

export interface WikiPart {
  text: string;
  html: string;
}

export interface WikiPageRecord {
  /** Decoded web-path name. */
  name: string;
  title: string;
  sha: string;
  author: string;
  date: string;
  message: string;
  commitCount: number;
  text: string;
  html: string;
  sidebar: WikiPart | null;
  footer: WikiPart | null;
}

export interface WikiPageMeta {
  name: string;
  title: string;
  sha: string;
  date: string;
  author: string;
}

export type WikiList =
  | {kind: 'pages'; pages: WikiPageMeta[]}
  | {kind: 'disabled'}
  | {kind: 'external'; url: string}
  | {kind: 'empty'};

export type Slot<T> =
  | {state: 'loading'}
  /** `stale` means cached data awaiting revalidation. */
  | {state: 'ready'; value: T; stale: boolean}
  /** Forgejo confirmed absence with 404. */
  | {state: 'missing'}
  /** Unreachable and no locally cached value. */
  | {state: 'offline'}
  | {state: 'error'; error: string; status: number};

/** Avoid a duplicate read between hover prefetch and click. */
const FRESH = 30_000;

/** Shared sidebar/footer renderings are reused across pages in the session. */
const RENDERED_MAX = 64;

const LIST_LIMIT = 200;
const LIST_MAX_REQUESTS = 25;

export class WikiSource {
  private readonly slots = observable.map<string, Slot<unknown>>({}, {deep: false});
  private readonly asked = new Map<string, number>();
  private readonly tried = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly rendered = new Map<string, Promise<string>>();
  private readonly app: App;
  private readonly cache: CodeCache;

  constructor(app: App, cache: CodeCache) {
    this.app = app;
    this.cache = cache;
  }

  static pageKey(repoId: number, page: string): string {
    return `wikip:${String(repoId)}:${page}`;
  }

  static listKey(repoId: number): string {
    return `wikil:${String(repoId)}`;
  }

  /** Observable memory-only read for the first frame. */
  page(repoId: number, page: string): Slot<WikiPageRecord> {
    return this.slot<WikiPageRecord>(WikiSource.pageKey(repoId, page));
  }

  list(repoId: number): Slot<WikiList> {
    return this.slot<WikiList>(WikiSource.listKey(repoId));
  }

  private slot<T>(key: string): Slot<T> {
    const s = this.slots.get(key) as Slot<T> | undefined;
    if (s) return s;
    const hit = this.cache.peek<T>(key);
    return hit === undefined ? {state: 'loading'} : {state: 'ready', value: hit, stale: true};
  }

  private set(key: string, s: Slot<unknown>): void {
    runInAction(() => {
      this.slots.set(key, s);
    });
  }

  loadPage(repoId: number, owner: string, repo: string, page: string, force = false): Promise<void> {
    const key = WikiSource.pageKey(repoId, page);
    return this.load(key, force, async (old: WikiPageRecord | undefined) => {
      const res = await online<ApiWikiPage>(this.app, {api: 'v1', path: `${repoPath(owner, repo)}/wiki/page/${encodeURIComponent(page)}`});
      if (!res) throw new RequestFailed(502, 'Forgejo sent no page.');
      return this.record(repoId, page, res, old);
    });
  }

  loadList(repoId: number, owner: string, repo: string, force = false): Promise<void> {
    return this.load(WikiSource.listKey(repoId), force, async () => {
      const pages: WikiPageMeta[] = [];
      try {
        for (let n = 1; n <= LIST_MAX_REQUESTS; n++) {
          const part = await online<ApiWikiMeta[]>(this.app, {api: 'v1', path: `${repoPath(owner, repo)}/wiki/pages?page=${String(n)}&limit=${String(LIST_LIMIT)}`});
          if (!part?.length) break;
          pages.push(...part.map(metaOf));
        }
      } catch (err) {
        // An empty list can mean no pages or a disabled wiki; ask the repository to distinguish.
        if (!(err instanceof RequestFailed) || err.status !== 404) throw err;
        return await this.noPages(owner, repo);
      }
      return pages.length ? {kind: 'pages', pages} : {kind: 'empty'};
    });
  }

  /** Prefetch errors belong to the view, not the hovered link. */
  prefetchPage(repoId: number, owner: string, repo: string, page: string): void {
    const key = WikiSource.pageKey(repoId, page);
    // Throttle repeated hovers, including missing pages.
    if (!navigator.onLine || Date.now() - (this.tried.get(key) ?? 0) < FRESH) return;
    this.tried.set(key, Date.now());
    this.loadPage(repoId, owner, repo, page).catch(() => undefined);
  }

  private async noPages(owner: string, repo: string): Promise<WikiList> {
    const r = await online<{has_wiki?: boolean; external_wiki?: {external_wiki_url?: string} | null}>(this.app, {api: 'v1', path: repoPath(owner, repo)});
    const url = r?.external_wiki?.external_wiki_url;
    if (url && /^https?:\/\//i.test(url)) return {kind: 'external', url};
    return r?.has_wiki ? {kind: 'empty'} : {kind: 'disabled'};
  }

  /** Deduplicate by key; show cached data first and retain it on network failure. */
  private load<T>(key: string, force: boolean, fetcher: (old: T | undefined) => Promise<T>): Promise<void> {
    const running = this.inflight.get(key);
    if (running) return running;
    const cur = this.slots.get(key) as Slot<T> | undefined;
    if (!force && cur?.state === 'ready' && !cur.stale && Date.now() - (this.asked.get(key) ?? 0) < FRESH) return Promise.resolve();
    const p = (async () => {
      let old = cur?.state === 'ready' ? cur.value : this.cache.peek<T>(key);
      old ??= await this.cache.get<T>(key);
      if (old !== undefined && cur?.state !== 'ready') this.set(key, {state: 'ready', value: old, stale: true});
      else if (cur?.state !== 'loading' && cur !== undefined) this.set(key, {state: 'loading'});
      if (!navigator.onLine) {
        this.set(key, old === undefined ? {state: 'offline'} : {state: 'ready', value: old, stale: false});
        return;
      }
      try {
        const v = await fetcher(old);
        this.asked.set(key, Date.now());
        this.cache.put(key, v);
        this.set(key, {state: 'ready', value: v, stale: false});
      } catch (err) {
        const status = err instanceof RequestFailed ? err.status : 0;
        if (status === 404) {
          this.cache.delete(key);
          this.set(key, {state: 'missing'});
        } else if (old !== undefined) {
          this.set(key, {state: 'ready', value: old, stale: false});
        } else if (status === 0) {
          this.set(key, {state: 'offline'});
        } else {
          this.set(key, {state: 'error', error: failureText(err), status});
        }
      }
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async record(repoId: number, page: string, res: ApiWikiPage, old: WikiPageRecord | undefined): Promise<WikiPageRecord> {
    const text = decodeContent(res.content_base64);
    const sidebar = page === SIDEBAR ? '' : decodeContent(res.sidebar);
    const footer = page === FOOTER ? '' : decodeContent(res.footer);
    const part = async (t: string, was: WikiPart | null | undefined): Promise<WikiPart | null> => {
      if (!t.trim()) return null;
      return {text: t, html: was?.text === t ? was.html : await this.render(repoId, t)};
    };
    const [html, side, foot] = await Promise.all([
      old?.text === text ? Promise.resolve(old.html) : this.render(repoId, text),
      part(sidebar, old?.sidebar),
      part(footer, old?.footer),
    ]);
    const c = res.last_commit;
    return {
      name: page, title: res.title, sha: c?.sha ?? '', author: c?.author?.name ?? '', date: c?.author?.date ?? '', message: c?.message ?? '',
      commitCount: res.commit_count ?? 0, text, html, sidebar: side, footer: foot,
    };
  }

  /** Forgejo wiki rendering is cached by repository/text for the session. */
  render(repoId: number, text: string): Promise<string> {
    if (!text.trim()) return Promise.resolve('');
    const key = `${String(repoId)}\0${text}`;
    const hit = this.rendered.get(key);
    if (hit) return hit;
    const body: APIMarkupRequest = {repo_id: repoId, ref: '', path: '', text, wiki: true};
    const p = online<APIMarkupResponse>(this.app, {method: 'POST', api: 'sync', path: '/markup', body}).then((r) => r?.html ?? '');
    this.rendered.set(key, p);
    p.catch(() => {
      this.rendered.delete(key);
    });
    for (const k of this.rendered.keys()) {
      if (this.rendered.size <= RENDERED_MAX) break;
      this.rendered.delete(k);
    }
    return p;
  }


  /** Resolve with the page name Forgejo derives from the title. */
  async create(repoId: number, owner: string, repo: string, edit: {title: string; text: string; message: string}): Promise<string> {
    const res = await online<ApiWikiPage>(this.app, {
      method: 'POST', api: 'v1', path: `${repoPath(owner, repo)}/wiki/new`,
      body: {title: edit.title, content_base64: encodeContent(edit.text), message: edit.message},
    });
    return this.saved(repoId, owner, repo, res, undefined);
  }

  /** A title change renames the page; resolve with its resulting name. */
  async edit(repoId: number, owner: string, repo: string, page: string, edit: {title: string; text: string; message: string}): Promise<string> {
    const res = await online<ApiWikiPage>(this.app, {
      method: 'PATCH', api: 'v1', path: `${repoPath(owner, repo)}/wiki/page/${encodeURIComponent(page)}`,
      body: {title: edit.title, content_base64: encodeContent(edit.text), message: edit.message},
    });
    return this.saved(repoId, owner, repo, res, page);
  }

  async remove(repoId: number, owner: string, repo: string, page: string): Promise<void> {
    await online(this.app, {method: 'DELETE', api: 'v1', path: `${repoPath(owner, repo)}/wiki/page/${encodeURIComponent(page)}`});
    const key = WikiSource.pageKey(repoId, page);
    this.cache.delete(key);
    this.set(key, {state: 'missing'});
    this.dropList(repoId, owner, repo, page);
  }

  private async saved(repoId: number, owner: string, repo: string, res: ApiWikiPage | undefined, was: string | undefined): Promise<string> {
    if (!res) throw new RequestFailed(502, 'Forgejo sent no page.');
    const name = pageOfSubUrl(res.sub_url);
    const key = WikiSource.pageKey(repoId, name);
    if (was !== undefined && was !== name) {
      this.cache.delete(WikiSource.pageKey(repoId, was));
      this.set(WikiSource.pageKey(repoId, was), {state: 'missing'});
    }
    try {
      const old = this.cache.peek<WikiPageRecord>(key);
      const rec = await this.record(repoId, name, res, old);
      this.cache.put(key, rec);
      this.asked.set(key, Date.now());
      this.set(key, {state: 'ready', value: rec, stale: false});
    } catch {
      // Rendering failure must not turn a successful save into a failed write.
      this.cache.delete(key);
      this.asked.delete(key);
      runInAction(() => {
        this.slots.delete(key);
      });
    }
    this.dropList(repoId, owner, repo, was);
    return name;
  }

  private dropList(repoId: number, owner: string, repo: string, removed: string | undefined): void {
    const key = WikiSource.listKey(repoId);
    const cur = this.slots.get(key) as Slot<WikiList> | undefined;
    if (removed !== undefined && cur?.state === 'ready' && cur.value.kind === 'pages') {
      this.set(key, {state: 'ready', value: {kind: 'pages', pages: cur.value.pages.filter((p) => p.name !== removed)}, stale: true});
    }
    void this.loadList(repoId, owner, repo, true).catch(() => undefined);
  }
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function metaOf(m: ApiWikiMeta): WikiPageMeta {
  const c = m.last_commit;
  return {name: pageOfSubUrl(m.sub_url), title: m.title, sha: c?.sha ?? '', date: c?.author?.date ?? '', author: c?.author?.name ?? ''};
}

const sources = new WeakMap<object, WikiSource>();

export function wikiSource(app: App): WikiSource | undefined {
  const s = app.session;
  const code = codeSource(app);
  if (!s || !code) return undefined;
  let src = sources.get(s);
  if (!src) sources.set(s, src = new WikiSource(app, code.cache));
  return src;
}

export function prefetchWikiPage(app: App, repoId: number, owner: string, repo: string, page: string): void {
  wikiSource(app)?.prefetchPage(repoId, owner, repo, page);
}
