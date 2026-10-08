// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Where code views get git content (PLAN §5.5, §5.7): one CodeSource per
// session. Every read is addressed by SHA — B9's immutable endpoints for
// trees, blobs, blames and diffs; API v1 for commit lists and compares of
// full SHAs — so an answer is cached forever (cache.ts) and a cached answer
// never needs the network: views that were seen once work offline.
// Highlighting and diff parsing go to the code worker (Comlink).
//
// Requests carry the session's token in a header only (`credentials:
// 'omit'`, no redirects). Only complete 2xx answers are cached (B9: a diff
// cut by a git failure rejects while being read).

import {type Remote, wrap} from 'comlink';
import {RequestFailed} from '../app/api.ts';
import {sitePath} from '../app/config.ts';
import {appWorkerURL} from '../app/trusted.ts';
import type {App, Session} from '../app/store.ts';
import {APIPrefix, type APIBlame, type APITree, type APITreeEntry} from '../protocol/types.gen.ts';
import type {CodeWorkerApi, Highlight} from '../workers/code.worker.ts';
import workerUrl from '../workers/code.worker.ts?worker&url';
import {CodeCache} from './cache.ts';
import type {DiffFile} from './diff.ts';
import {langOf} from './lang.ts';

export type {Highlight} from '../workers/code.worker.ts';

/** Files above this size are not fetched for display (the classic UI's raw link is offered). */
export const MAX_FILE = 4 * 1024 * 1024;

/**
 * Diffs above this size are not shown (nor cached, nor prefetched): B9 streams
 * diffs without a limit, and one would be parsed, held and stored several
 * times over (the classic UI caps diffs too).
 */
export const MAX_DIFF = 8 * 1024 * 1024;

/** A highlight running longer than this is stopped (the text stays plain). */
const HIGHLIGHT_LIMIT = 6000;

/** Content too large to show here (status 413 for the views). */
export class TooLarge extends RequestFailed {
  override name = 'TooLarge';
  constructor(what: string) {
    super(413, `${what} is too large to show here.`);
  }
}

/** Reads a text answer, stopping (TooLarge) beyond `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('Content-Length') ?? 0);
  if (declared > max || !res.body) {
    void res.body?.cancel();
    if (declared > max) throw new TooLarge('This diff');
    return res.text();
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      void reader.cancel();
      throw new TooLarge('This diff');
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export type FileContent =
  | {kind: 'text'; text: string; size: number}
  | {kind: 'image'; bytes: ArrayBuffer; type: string; size: number}
  | {kind: 'binary'; size: number}
  | {kind: 'large'; size: number};

/** A commit as API v1 lists it (the fields the views use). */
export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorLogin: string;
  date: string;
  parents: string[];
}

export interface CompareInfo {
  commits: CommitInfo[];
  total: number;
}

/** No answer and nothing cached: offline (or Forgejo unreachable). */
export class NotCached extends Error {
  override name = 'NotCached';
}

const IMAGES: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp'};

/** A repository path for a request URL; "." and ".." segments are refused (the URL would resolve them away). */
export function encodePath(p: string): string {
  const segs = p.split('/');
  if (segs.some((s) => s === '.' || s === '..' || s === '')) throw new RequestFailed(400, 'Not a path in a repository.');
  return segs.map(encodeURIComponent).join('/');
}

/** Text or bytes: NUL in the first 8000 bytes means binary (git's rule). */
export function decodeFile(bytes: ArrayBuffer, path: string): FileContent {
  const size = bytes.byteLength;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const image = IMAGES[ext];
  if (image) return {kind: 'image', bytes, type: image, size};
  const head = new Uint8Array(bytes, 0, Math.min(8000, size));
  if (head.includes(0)) return {kind: 'binary', size};
  return {kind: 'text', text: new TextDecoder('utf-8').decode(bytes), size};
}

interface ApiCommit {
  sha: string;
  commit: {message: string; author: {name: string; email: string; date: string}};
  author?: {login?: string} | null;
  parents?: {sha: string}[] | null;
}

function commitInfo(c: ApiCommit): CommitInfo {
  return {
    sha: c.sha, message: c.commit.message, authorName: c.commit.author.name, authorEmail: c.commit.author.email,
    authorLogin: c.author?.login ?? '', date: c.commit.author.date, parents: (c.parents ?? []).map((p) => p.sha),
  };
}

export class CodeSource {
  readonly cache: CodeCache;
  /** The worker module runs twice: a parser and a highlighter (stopped and replaced when a highlight runs away). */
  private parser: {w: Worker; api: Remote<CodeWorkerApi>} | undefined;
  private highlighter: {w: Worker; api: Remote<CodeWorkerApi>} | undefined;
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Diffs parsed in the worker this session (key → files); the worker keeps them for highlighting. */
  private readonly parsed = new Map<string, Promise<DiffFile[]>>();
  /** The same, once parsed (a diff opened again paints in its first frame). */
  private readonly parsedDone = new Map<string, DiffFile[]>();
  private readonly off: () => void;
  private readonly app: App;
  private readonly s: Session;

  constructor(app: App, s: Session) {
    this.app = app;
    this.s = s;
    this.cache = new CodeCache(s.data.db);
    // A repository the viewer may no longer read: its content goes too.
    this.off = s.data.on('revoked', ({group}) => {
      if (group.startsWith('repo:')) void this.cache.purgeRepo(Number(group.slice(5)));
    });
  }

  private spawn(name: string): {w: Worker; api: Remote<CodeWorkerApi>} {
    const at = workerUrl.indexOf('assets/');
    const url = at >= 0 ? `${this.app.config.base}${workerUrl.slice(at)}` : workerUrl;
    const w = new Worker(appWorkerURL(this.app.config.base, url), {type: 'module', name});
    return {w, api: wrap<CodeWorkerApi>(w)};
  }

  private parse(): Remote<CodeWorkerApi> {
    this.parser ??= this.spawn('code-parse');
    return this.parser.api;
  }

  /**
   * Runs a highlight with a watchdog: a TextMate grammar can backtrack for
   * minutes on crafted text (a file in a pull request). Past HIGHLIGHT_LIMIT
   * the highlighter is terminated (a new one starts with the next call) and
   * the text is plain (null) — every call waiting on it too.
   */
  private async watched(run: (api: Remote<CodeWorkerApi>) => Promise<Highlight | null>): Promise<Highlight | null> {
    this.highlighter ??= this.spawn('code-highlight');
    const h = this.highlighter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, HIGHLIGHT_LIMIT);
    });
    try {
      const r = await Promise.race([run(h.api), timeout]);
      if (r !== 'timeout') return r;
      if (this.highlighter === h) {
        this.highlighter = undefined;
        h.w.terminate();
      }
      return null;
    } catch {
      return null; // terminated under it (another call's timeout): plain
    } finally {
      clearTimeout(timer);
    }
  }

  /** One request per key at a time; cache first. `fetcher` returns the value to cache (and its size). */
  private cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = (async () => {
      const hit = await this.cache.get<T>(key);
      if (hit !== undefined) return hit;
      const v = await fetcher();
      this.cache.put(key, v);
      return v;
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** A value already in memory (the first frame of a view: no flash of a placeholder). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what it stored under the key
  peek<T>(key: string): T | undefined {
    return this.cache.peek<T>(key);
  }

  private async request(api: 'sync' | 'v1', path: string, signal?: AbortSignal): Promise<Response> {
    if (!navigator.onLine) throw new NotCached('offline');
    const token = await this.s.auth.token();
    let res: Response;
    try {
      res = await fetch(sitePath(this.app.config, `${api === 'v1' ? '/api/v1' : APIPrefix}${path}`), {
        headers: {Authorization: `Bearer ${token}`},
        credentials: 'omit',
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new NotCached('Forgejo could not be reached.');
    }
    if (res.type === 'opaqueredirect') throw new RequestFailed(0, 'Forgejo answered with a redirect.');
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json() as {message?: string}).message ?? '';
      } catch {
        // not JSON
      }
      throw new RequestFailed(res.status, msg || `Forgejo answered ${String(res.status)}.`);
    }
    return res;
  }

  // ---- B9 immutable reads ----

  static treeKey(repoId: number, commit: string, path: string): string {
    return `tree:${String(repoId)}:${commit}:${path}`;
  }

  tree(repoId: number, commit: string, path: string): Promise<APITree> {
    return this.cached(CodeSource.treeKey(repoId, commit, path), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/tree/${commit}${path ? `/${encodePath(path)}` : ''}`);
      return await res.json() as APITree;
    });
  }

  /** The entry a path names at a commit (from its parent directory's tree), or undefined. */
  async entry(repoId: number, commit: string, path: string): Promise<APITreeEntry | undefined> {
    const i = path.lastIndexOf('/');
    const t = await this.tree(repoId, commit, i < 0 ? '' : path.slice(0, i));
    const name = i < 0 ? path : path.slice(i + 1);
    return t.entries.find((e) => e.name === name);
  }

  static blobKey(repoId: number, sha: string): string {
    return `blob:${String(repoId)}:${sha}`;
  }

  /** A file's content by its blob SHA (`size` from the tree entry decides "too large" before any request). */
  blob(repoId: number, sha: string, path: string, size: number | undefined): Promise<FileContent> {
    if (size !== undefined && size > MAX_FILE) return Promise.resolve({kind: 'large', size});
    return this.cached(CodeSource.blobKey(repoId, sha), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/blobs/${sha}`);
      return decodeFile(await res.arrayBuffer(), path);
    });
  }

  /** A file by (commit, path) when its blob SHA is not known (raw endpoint). */
  raw(repoId: number, commit: string, path: string): Promise<FileContent> {
    return this.cached(`raw:${String(repoId)}:${commit}:${path}`, async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/raw/${commit}/${encodePath(path)}`);
      const len = Number(res.headers.get('Content-Length') ?? 0);
      if (len > MAX_FILE) {
        void res.body?.cancel();
        return {kind: 'large', size: len} satisfies FileContent;
      }
      return decodeFile(await res.arrayBuffer(), path);
    });
  }

  blame(repoId: number, commit: string, path: string): Promise<APIBlame> {
    return this.cached(`blame:${String(repoId)}:${commit}:${path}`, async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/blame/${commit}/${encodePath(path)}`);
      return await res.json() as APIBlame;
    });
  }

  static diffKey(repoId: number, base: string, head: string): string {
    return `diff:${String(repoId)}:${base}:${head}`;
  }

  /** The unified diff between two commits (base empty: a commit against its first parent). */
  diffText(repoId: number, base: string, head: string, signal?: AbortSignal): Promise<string> {
    return this.cached(CodeSource.diffKey(repoId, base, head), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/diff/${base ? `${base}/` : ''}${head}`, signal);
      return await readCapped(res, MAX_DIFF);
    });
  }

  /** Whether a diff is on this device (prefetched or seen). */
  async hasDiff(repoId: number, base: string, head: string): Promise<boolean> {
    return await this.cache.get(CodeSource.diffKey(repoId, base, head)) !== undefined;
  }

  /** The diff parsed in the worker (once per session and diff). */
  diff(repoId: number, base: string, head: string): Promise<DiffFile[]> {
    const key = CodeSource.diffKey(repoId, base, head);
    let p = this.parsed.get(key);
    if (!p) {
      p = this.diffText(repoId, base, head).then((text) => this.parse().parseDiff(text));
      p.then((files) => {
        this.parsedDone.set(key, files);
        // A few parsed diffs stay in memory.
        for (const k of this.parsedDone.keys()) {
          if (this.parsedDone.size <= 4) break;
          this.parsedDone.delete(k);
          this.parsed.delete(k);
        }
      }, () => {
        this.parsed.delete(key);
      });
      this.parsed.set(key, p);
    }
    return p;
  }

  /** A diff parsed in this session, if it is in memory. */
  peekDiff(repoId: number, base: string, head: string): DiffFile[] | undefined {
    return this.parsedDone.get(CodeSource.diffKey(repoId, base, head));
  }

  /** One file of a parsed diff, highlighted per diff line (null: plain). */
  async diffHighlight(repoId: number, base: string, head: string, index: number): Promise<Highlight | null> {
    const file = (await this.diff(repoId, base, head))[index];
    return file ? this.watched((api) => api.highlightDiffFile(file)) : null;
  }

  /** A file's highlighting, cached by blob SHA (null: plain). */
  highlight(repoId: number, blobSha: string, path: string, text: string): Promise<Highlight | null> {
    const lang = langOf(path);
    if (!lang) return Promise.resolve(null);
    // A timeout caches null: this content stays plain on this device (it would run away again).
    return this.cached(`hl:${String(repoId)}:${blobSha}:${lang}`, () => this.watched((api) => api.highlight(text, lang)));
  }

  /** Highlighting already in memory (a file switched back to paints highlighted in its first frame). */
  peekHighlight(repoId: number, blobSha: string, path: string): Highlight | null | undefined {
    const lang = langOf(path);
    if (!lang) return null;
    return this.cache.peek(`hl:${String(repoId)}:${blobSha}:${lang}`);
  }

  // ---- API v1 (immutable when addressed by full SHAs) ----

  private repoPath(repoId: number): string {
    const r = this.s.data.pool.model('Repository').get(repoId)?.data;
    if (!r) throw new NotCached('the repository is not on this device');
    return `/repos/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}`;
  }

  /** The history from a commit (50 per page), optionally of one path. */
  commits(repoId: number, sha: string, page: number, path = ''): Promise<CommitInfo[]> {
    return this.cached(`commits:${String(repoId)}:${sha}:${String(page)}:${path}`, async () => {
      const q = new URLSearchParams({sha, page: String(page), limit: '50', stat: 'false', verification: 'false', files: 'false'});
      if (path) q.set('path', path);
      const res = await this.request('v1', `${this.repoPath(repoId)}/commits?${q.toString()}`);
      return (await res.json() as ApiCommit[]).map(commitInfo);
    });
  }

  commit(repoId: number, sha: string): Promise<CommitInfo> {
    return this.cached(`commit:${String(repoId)}:${sha}`, async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/git/commits/${sha}?stat=false&verification=false&files=false`);
      return commitInfo(await res.json() as ApiCommit);
    });
  }

  /** Commits on `head` not on `base` (both full SHAs). */
  compare(repoId: number, base: string, head: string): Promise<CompareInfo> {
    return this.cached(`compare:${String(repoId)}:${base}:${head}`, async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/compare/${base}...${head}`);
      const j = await res.json() as {total_commits?: number; commits?: ApiCommit[] | null};
      const commits = (j.commits ?? []).map(commitInfo);
      return {commits, total: j.total_commits ?? commits.length};
    });
  }

  close(): void {
    this.off();
    this.cache.close();
    this.parser?.w.terminate();
    this.highlighter?.w.terminate();
  }
}

const sources = new WeakMap<Session, CodeSource>();

/** The session's code source (started on first use: no code view, no worker, no cache). */
export function codeSource(app: App): CodeSource | undefined {
  const s = app.session;
  if (!s) return undefined;
  let src = sources.get(s);
  if (!src) sources.set(s, src = new CodeSource(app, s));
  return src;
}
