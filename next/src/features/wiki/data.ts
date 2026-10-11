// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's wiki: read through API v1 (`/repos/{owner}/{repo}/wiki/…`)
// and rendered by Forgejo (B9 /markup with `wiki`: links resolve to the
// wiki's pages, images to its files). The wiki is not in the sync pool, so
// what was fetched is kept in the code cache (memory LRU over IndexedDB,
// code/cache.ts) by repository and page — the page's text, its rendering
// and its last commit — and shown at once the next time (offline too),
// while the page is asked for again in the background (stale while
// revalidate): a page whose last commit and sidebar did not change is not
// rendered again. A page is fetched ahead on hover (links, rows), so
// opening it paints from memory. Writes (create, edit, delete) are online
// only, through API v1, and update the cache with Forgejo's answer.

import {observable, runInAction} from 'mobx';
import {online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {CodeCache} from '../../code/cache.ts';
import {codeSource} from '../../code/source.ts';
import type {APIMarkupRequest, APIMarkupResponse} from '../../protocol/types.gen.ts';
import {decodeContent, encodeContent, FOOTER, pageOfSubUrl, SIDEBAR} from './paths.ts';

/** API v1's WikiCommit. */
interface ApiWikiCommit {
  sha: string;
  author?: {name?: string; email?: string; date?: string} | null;
  message?: string;
}

/** API v1's WikiPageMetaData. */
interface ApiWikiMeta {
  title: string;
  sub_url: string;
  last_commit?: ApiWikiCommit | null;
}

/** API v1's WikiPage. */
interface ApiWikiPage extends ApiWikiMeta {
  content_base64?: string;
  commit_count?: number;
  sidebar?: string;
  footer?: string;
}

/** A part of a page shown around it (the wiki's _Sidebar, _Footer), rendered. */
export interface WikiPart {
  text: string;
  html: string;
}

/** A page as shown (cached by repository and page). */
export interface WikiPageRecord {
  /** The page's name (its web path, decoded: paths.ts). */
  name: string;
  title: string;
  /** Its last commit (in the wiki's repository). */
  sha: string;
  author: string;
  date: string;
  message: string;
  /** How many commits changed it (its revisions). */
  commitCount: number;
  text: string;
  html: string;
  sidebar: WikiPart | null;
  footer: WikiPart | null;
}

/** A page as the wiki lists it. */
export interface WikiPageMeta {
  name: string;
  title: string;
  sha: string;
  date: string;
  author: string;
}

/**
 * The wiki's page list, or why there is none: `disabled` (the repository has no wiki), `external` (its wiki is
 * elsewhere: `url`), `empty` (a wiki without a page yet).
 */
export type WikiList =
  | {kind: 'pages'; pages: WikiPageMeta[]}
  | {kind: 'disabled'}
  | {kind: 'external'; url: string}
  | {kind: 'empty'};

export type Slot<T> =
  | {state: 'loading'}
  /** `stale`: from the cache, asked for again. */
  | {state: 'ready'; value: T; stale: boolean}
  /** No such page (Forgejo answered 404). */
  | {state: 'missing'}
  /** Offline (or unreachable) and not on this device. */
  | {state: 'offline'}
  | {state: 'error'; message: string; status: number};

/** An answer this recent is not asked for again (a hover's prefetch, then the click). */
const FRESH = 30_000;

/** Rendered texts kept in memory per session (the sidebar and footer are the same on every page). */
const RENDERED_MAX = 64;

/** Entries per request of the page list (the server looks up each page's last commit). */
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

  /** What is known of a page now (observed; memory only: the view's first frame). */
  page(repoId: number, page: string): Slot<WikiPageRecord> {
    return this.slot<WikiPageRecord>(WikiSource.pageKey(repoId, page));
  }

  /** What is known of the page list now (observed). */
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

  /** Loads a page (the cache first, then Forgejo unless asked for in the last moments). */
  loadPage(repoId: number, owner: string, repo: string, page: string, force = false): Promise<void> {
    const key = WikiSource.pageKey(repoId, page);
    return this.load(key, force, async (old: WikiPageRecord | undefined) => {
      const res = await online<ApiWikiPage>(this.app, {api: 'v1', path: `${repoPath(owner, repo)}/wiki/page/${encodeURIComponent(page)}`});
      if (!res) throw new RequestFailed(502, 'Forgejo sent no page.');
      return this.record(repoId, page, res, old);
    });
  }

  /** Loads the page list (and, when there is none, why). */
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
        // No wiki repository yet, or no wiki: the repository says which.
        if (!(err instanceof RequestFailed) || err.status !== 404) throw err;
        return await this.noPages(owner, repo);
      }
      return pages.length ? {kind: 'pages', pages} : {kind: 'empty'};
    });
  }

  /** Fetches a page ahead (a link hovered): errors are the view's to show when it opens. */
  prefetchPage(repoId: number, owner: string, repo: string, page: string): void {
    const key = WikiSource.pageKey(repoId, page);
    // Hovering the same link again (one that names no page, say) asks once in a while, not on every move.
    if (!navigator.onLine || Date.now() - (this.tried.get(key) ?? 0) < FRESH) return;
    this.tried.set(key, Date.now());
    this.loadPage(repoId, owner, repo, page).catch(() => undefined);
  }

  /** Why a wiki lists no page (API v1's repository: its wiki unit, external or not, and whether it has content). */
  private async noPages(owner: string, repo: string): Promise<WikiList> {
    const r = await online<{has_wiki?: boolean; external_wiki?: {external_wiki_url?: string} | null}>(this.app, {api: 'v1', path: repoPath(owner, repo)});
    const url = r?.external_wiki?.external_wiki_url;
    if (url && /^https?:\/\//i.test(url)) return {kind: 'external', url};
    return r?.has_wiki ? {kind: 'empty'} : {kind: 'disabled'};
  }

  /**
   * One request per key at a time. The cached value is shown first (stale), then the answer replaces it; offline
   * or unreachable the cached value stays (not stale: there is nothing newer to wait for).
   */
  private load<T>(key: string, force: boolean, fetcher: (old: T | undefined) => Promise<T>): Promise<void> {
    const running = this.inflight.get(key);
    if (running) return running;
    const cur = this.slots.get(key) as Slot<T> | undefined;
    if (!force && cur?.state === 'ready' && !cur.stale && Date.now() - (this.asked.get(key) ?? 0) < FRESH) return Promise.resolve();
    const p = (async () => {
      let old = cur?.state === 'ready' ? cur.value : this.cache.peek<T>(key);
      old ??= await this.cache.get<T>(key);
      // The device's copy shows while Forgejo is asked (a value already on screen stays as it is).
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
          this.set(key, {state: 'error', message: err instanceof Error ? err.message : String(err), status});
        }
      }
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** A page's record from API v1's answer: the parts that did not change keep their rendering. */
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

  /** A wiki text rendered by Forgejo (B9 /markup with `wiki`), once per text in this session. */
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

  // ---- Writes (online only: API v1) ----

  /** Creates a page; resolves with its name (Forgejo makes it from the title). */
  async create(repoId: number, owner: string, repo: string, edit: {title: string; text: string; message: string}): Promise<string> {
    const res = await online<ApiWikiPage>(this.app, {
      method: 'POST', api: 'v1', path: `${repoPath(owner, repo)}/wiki/new`,
      body: {title: edit.title, content_base64: encodeContent(edit.text), message: edit.message},
    });
    return this.saved(repoId, owner, repo, res, undefined);
  }

  /** Saves a page (a new title renames it); resolves with its name afterwards. */
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

  /** Forgejo's answer to a write: the page's record (rendered), the list asked for again. */
  private async saved(repoId: number, owner: string, repo: string, res: ApiWikiPage | undefined, was: string | undefined): Promise<string> {
    if (!res) throw new RequestFailed(502, 'Forgejo sent no page.');
    const name = pageOfSubUrl(res.sub_url);
    const key = WikiSource.pageKey(repoId, name);
    if (was !== undefined && was !== name) {
      // Renamed: the old address has no page any more.
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
      // Saved, but not rendered: the page loads when it opens.
      this.cache.delete(key);
      this.asked.delete(key);
      runInAction(() => {
        this.slots.delete(key);
      });
    }
    this.dropList(repoId, owner, repo, was);
    return name;
  }

  /** The page list changed: asked for again (a removed page leaves it at once). */
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

/** The session's wiki source (started on first use). */
export function wikiSource(app: App): WikiSource | undefined {
  const s = app.session;
  const code = codeSource(app);
  if (!s || !code) return undefined;
  let src = sources.get(s);
  if (!src) sources.set(s, src = new WikiSource(app, code.cache));
  return src;
}

/** Fetches a page ahead (a route's preload: a link hovered). */
export function prefetchWikiPage(app: App, repoId: number, owner: string, repo: string, page: string): void {
  wikiSource(app)?.prefetchPage(repoId, owner, repo, page);
}
