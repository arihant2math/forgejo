// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// SHA-addressed content is cached per session for offline reads.
// Parse diffs locally: deserializing per-line worker objects costs more than parsing.
// Requests use header-only credentials and reject redirects; cache only complete 2xx bodies.

import {RequestFailed} from '../app/api.ts';
import {sitePath} from '../app/config.ts';
import {appWorkerURL} from '../app/trusted.ts';
import type {App, Session} from '../app/store.ts';
import {
  APIPrefix, type APIBlame, type APICommitActivity, type APIContributors, type APIMarkupRequest, type APIMarkupResponse, type APITree, type APITreeEntry,
} from '../protocol/types.gen.ts';
import {repoOfGroup} from '../data/models.ts';
import {netSignal} from '../sync/net.ts';
import type {Highlight} from '../workers/code.worker.ts';
import workerUrl from '../workers/code.worker.ts?worker&url';
import {CodeCache} from './cache.ts';
import {aborted, Highlighter, type HighlightWorker, type Priority, TimedOut, workerHighlighter} from './highlighter.ts';
import {isSha, type RefKind} from './refs.ts';
import {DEL, type DiffFile, filePath, parseDiff} from './diff.ts';
import {type Lang, langOf, LIMITS, TOKEN_FORMAT} from './shiki.ts';

export type {Highlight} from '../workers/code.worker.ts';

/** Maximum displayable file size in bytes. */
export const MAX_FILE = 4 * 1024 * 1024;

/** Byte cap for unbounded diff streams, which parsing and caching duplicate in memory. */
export const MAX_DIFF = 8 * 1024 * 1024;

/** Content too large to show here (status 413 for the views). */
export class TooLarge extends RequestFailed {
  override name = 'TooLarge';
  constructor(what: string) {
    super(413, `${what} is too large to show here.`);
  }
}

/** How many times the contributor statistics are asked while Forgejo computes them (≈ 2 s apart). */
const CONTRIBUTOR_ATTEMPTS = 90;

/** JSON answers (trees, blames, commit lists, compares) above this are refused: unrelated histories compare to every commit. */
const MAX_JSON = 16 * 1024 * 1024;

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await readCapped(res, MAX_JSON));
}

async function readCapped(res: Response, max: number): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(res, max));
}

/** Reads an answer's bytes, stopping (TooLarge) beyond `max` (whether or not it declares its length). */
async function readBytesCapped(res: Response, max: number): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('Content-Length') ?? 0);
  if (declared > max || !res.body) {
    void res.body?.cancel();
    if (declared > max) throw new TooLarge('This content');
    return res.arrayBuffer();
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
      throw new TooLarge('This content');
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return all.buffer;
}

export type FileContent =
  | {kind: 'text'; text: string; size: number}
  | {kind: 'image'; bytes: ArrayBuffer; type: string; size: number}
  | {kind: 'binary'; size: number}
  | {kind: 'large'; size: number};

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorLogin: string;
  /** Linked author's avatar; empty or absent when unavailable. */
  authorAvatar?: string;
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

/** A commit's file paths (CodeSource.paths): every blob, in git's order (by path). */
export interface PathList {
  paths: string[];
  /** More entries exist beyond the pagination cap. */
  truncated: boolean;
}

interface ApiTree {
  tree?: {path: string; type: string}[] | null;
  truncated?: boolean;
  total_count?: number;
}

/** A recursive tree is read up to this many pages (100 000 entries at Forgejo's default page size). */
const MAX_TREE_PAGES = 100;
/** Pages asked for together. */
const TREE_PAGES_AT_ONCE = 4;

interface ApiCommit {
  sha: string;
  commit: {message: string; author: {name: string; email: string; date: string}};
  author?: {login?: string; avatar_url?: string} | null;
  parents?: {sha: string}[] | null;
}

function commitInfo(c: ApiCommit): CommitInfo {
  return {
    sha: c.sha, message: c.commit.message, authorName: c.commit.author.name, authorEmail: c.commit.author.email,
    authorLogin: c.author?.login ?? '', authorAvatar: c.author?.avatar_url ?? '', date: c.commit.author.date, parents: (c.parents ?? []).map((p) => p.sha),
  };
}

export class CodeSource {
  readonly cache: CodeCache;
  private readonly hl: Highlighter;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly snippets = new Map<string, Snippet>();
  private readonly parsed = new Map<string, Promise<DiffFile[]>>();
  /** Completed parses for synchronous first-frame reads. */
  private readonly parsedDone = new Map<string, DiffFile[]>();
  private readonly off: () => void;
  private readonly app: App;
  private readonly s: Session;

  constructor(app: App, s: Session, opts: {spawn?: () => HighlightWorker} = {}) {
    this.app = app;
    this.s = s;
    this.cache = new CodeCache(s.data.db);
    this.hl = new Highlighter(opts.spawn ?? (() => this.spawn()));
    this.off = s.data.on('revoked', ({group}) => {
      const repo = repoOfGroup(group);
      if (repo !== undefined) void this.cache.purgeRepo(repo);
    });
  }

  private spawn(): HighlightWorker {
    const at = workerUrl.indexOf('assets/');
    const url = at >= 0 ? `${this.app.config.base}${workerUrl.slice(at)}` : workerUrl;
    return workerHighlighter(new Worker(appWorkerURL(this.app.config.base, url), {type: 'module', name: 'code-highlight'}));
  }

  /** Loads a grammar at idle priority to cache its chunk for offline use. */
  warm(lang: Lang): Promise<void> {
    return this.hl.warm(lang);
  }

  /** Deduplicates cache misses per key; keep rejects non-final values from persistence. */
  private cached<T>(key: string, fetcher: () => Promise<T>, keep?: (v: T) => boolean): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = (async () => {
      const hit = await this.cache.get<T>(key);
      if (hit !== undefined) return hit;
      const v = await fetcher();
      if (!keep || keep(v)) this.cache.put(key, v);
      return v;
    })().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Synchronous memory-only read. */
  peek<T>(key: string): T | undefined {
    return this.cache.peek<T>(key);
  }

  private async request(api: 'sync' | 'v1', path: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
    if (!navigator.onLine) throw new NotCached('offline');
    const token = await this.s.auth.token();
    let res: Response;
    try {
      res = await fetch(sitePath(this.app.config, `${api === 'v1' ? '/api/v1' : APIPrefix}${path}`), {
        headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)}),
        credentials: 'omit',
        redirect: 'manual',
        signal: netSignal(60_000, signal),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new NotCached('Forgejo could not be reached.');
    }
    if (res.type === 'opaqueredirect') throw new RequestFailed(0, 'Forgejo answered with a redirect.');
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await readJson(res) as {message?: string}).message ?? '';
      } catch {
        // not JSON
      }
      throw new RequestFailed(res.status, msg || `Forgejo answered ${String(res.status)}.`);
    }
    return res;
  }

  static treeKey(repoId: number, commit: string, path: string): string {
    return `tree:${String(repoId)}:${commit}:${path}`;
  }

  tree(repoId: number, commit: string, path: string): Promise<APITree> {
    return this.cached(CodeSource.treeKey(repoId, commit, path), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/tree/${commit}${path ? `/${encodePath(path)}` : ''}`);
      return await readJson(res) as APITree;
    });
  }

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
      try {
        return decodeFile(await readBytesCapped(res, MAX_FILE), path);
      } catch (err) {
        // (no declared length: at least the cap)
        if (err instanceof TooLarge) return {kind: 'large', size: len || MAX_FILE + 1} satisfies FileContent;
        throw err;
      }
    });
  }

  blame(repoId: number, commit: string, path: string): Promise<APIBlame> {
    return this.cached(`blame:${String(repoId)}:${commit}:${path}`, async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/blame/${commit}/${encodePath(path)}`);
      return await readJson(res) as APIBlame;
    });
  }

  static diffKey(repoId: number, base: string, head: string, whitespace = ''): string {
    return `diff:${String(repoId)}:${base}:${head}${whitespace ? `:whitespace=${whitespace}` : ''}`;
  }

  /** The unified diff between two commits (base empty: a commit against its first parent). */
  diffText(repoId: number, base: string, head: string, signal?: AbortSignal, whitespace = ''): Promise<string> {
    return this.cached(CodeSource.diffKey(repoId, base, head, whitespace), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/diff/${base ? `${base}/` : ''}${head}${whitespace ? `?whitespace=${encodeURIComponent(whitespace)}` : ''}`, signal);
      return await readCapped(res, MAX_DIFF);
    });
  }

  /** Whether a diff is on this device (prefetched or seen; its text is not read). */
  hasDiff(repoId: number, base: string, head: string, whitespace = ''): Promise<boolean> {
    return this.cache.has(CodeSource.diffKey(repoId, base, head, whitespace));
  }

  /** The diff parsed (once per session and diff). */
  diff(repoId: number, base: string, head: string, whitespace = ''): Promise<DiffFile[]> {
    const key = CodeSource.diffKey(repoId, base, head, whitespace);
    let p = this.parsed.get(key);
    if (!p) {
      p = this.diffText(repoId, base, head, undefined, whitespace).then(parseDiff);
      p.then((files) => {
        this.parsedDone.set(key, files);
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
  peekDiff(repoId: number, base: string, head: string, whitespace = ''): DiffFile[] | undefined {
    return this.parsedDone.get(CodeSource.diffKey(repoId, base, head, whitespace));
  }

  /** One file of a parsed diff, highlighted per diff line (null: plain). */
  async diffHighlight(repoId: number, base: string, head: string, index: number, whitespace = ''): Promise<Highlight | null> {
    const key = CodeSource.diffHlKey(repoId, base, head, index, whitespace);
    const hit = this.cache.peek<Highlight | null>(key);
    if (hit !== undefined) return hit;
    const file = (await this.diff(repoId, base, head, whitespace))[index];
    const lang = file && langOf(filePath(file));
    if (!file || !lang) return null;
    let h: Highlight | null;
    try {
      h = await this.hl.highlight(lang, (api) => api.highlightDiffFile(file));
    } catch (err) {
      if (!(err instanceof TimedOut)) throw err;
      h = null;
    }
    // Diff highlighting is cheap to redo; keep it only in memory.
    this.cache.remember(key, h);
    return h;
  }

  static diffHlKey(repoId: number, base: string, head: string, index: number, whitespace = ''): string {
    return `dhl:${String(repoId)}:${base}:${head}:${String(index)}:${whitespace}`;
  }

  peekDiffHighlight(repoId: number, base: string, head: string, index: number, whitespace = ''): Highlight | null | undefined {
    return this.cache.peek(CodeSource.diffHlKey(repoId, base, head, index, whitespace));
  }

  static highlightKey(repoId: number, blobSha: string, lang: Lang): string {
    return `hl:${String(repoId)}:${blobSha}:${lang}:${String(TOKEN_FORMAT)}`;
  }

  /** Caches by blob SHA; null means plain. Visible requests promote pending idle work. */
  highlight(repoId: number, blobSha: string, path: string, text: string, priority: Priority = 'now'): Promise<Highlight | null> {
    const lang = langOf(path);
    if (!lang || text.length > LIMITS.chars) return Promise.resolve(null);
    const key = CodeSource.highlightKey(repoId, blobSha, lang);
    if (priority === 'now') this.hl.promote(key);
    return this.cached(key, () => this.hl.highlight(lang, (api) => api.highlight(text, lang), {priority, key})).catch((err: unknown) => {
      if (!(err instanceof TimedOut)) throw err;
      // Plain for this session (it would run away again), not stored.
      this.cache.remember(key, null);
      return null;
    });
  }

  /** Reads stored highlighting into memory without a worker, ahead of first-frame rendering. */
  async loadHighlight(repoId: number, blobSha: string, path: string): Promise<void> {
    const lang = langOf(path);
    if (lang) await this.cache.get(CodeSource.highlightKey(repoId, blobSha, lang));
  }

  /** A snippet (a fenced code block, a code search hit) highlighted, kept in memory for the session (null: plain). */
  snippet(lang: Lang, text: string, signal?: AbortSignal): Promise<Highlight | null> {
    if (text.length > LIMITS.chars) return Promise.resolve(null);
    return this.shared(`snip:${lang}:${text}`, (s) => this.plainOnTimeout(this.hl.highlight(lang, (api) => api.highlight(text, lang), {signal: s})), signal);
  }

  /** A settled snippet() in memory: undefined when not (yet) highlighted. */
  peekSnippet(lang: Lang, text: string): Highlight | null | undefined {
    return this.snippets.get(`snip:${lang}:${text}`)?.v;
  }

  /** A few diff lines outside a diff (a review comment's hunk, a suggested change), highlighted per side like a diff. */
  diffSnippet(file: DiffFile, signal?: AbortSignal): Promise<Highlight | null> {
    const lang = langOf(filePath(file));
    if (!lang) return Promise.resolve(null);
    return this.shared(diffSnippetKey(lang, file), (s) => this.plainOnTimeout(this.hl.highlight(lang, (api) => api.highlightDiffFile(file), {signal: s})), signal);
  }

  peekDiffSnippet(file: DiffFile): Highlight | null | undefined {
    const lang = langOf(filePath(file));
    return lang ? this.snippets.get(diffSnippetKey(lang, file))?.v : null;
  }

  /** A text being edited: not cached (every version differs); abort what a newer version replaces. */
  highlightText(lang: Lang, text: string, signal?: AbortSignal): Promise<Highlight | null> {
    if (text.length > LIMITS.chars) return Promise.resolve(null);
    return this.plainOnTimeout(this.hl.highlight(lang, (api) => api.highlight(text, lang), {signal}));
  }

  /** Text that stalled the worker stays plain (it would run away again); other failures reject. */
  private plainOnTimeout(p: Promise<Highlight | null>): Promise<Highlight | null> {
    return p.catch((err: unknown) => {
      if (err instanceof TimedOut) return null;
      throw err;
    });
  }

  /**
   * One highlight per key for everyone asking. An asker's abort rejects its own promise; the highlight leaves the
   * queue only once every asker that passed a signal has aborted. A failed one is forgotten, so the next request tries again.
   */
  private shared(key: string, run: (signal: AbortSignal) => Promise<Highlight | null>, signal: AbortSignal | undefined): Promise<Highlight | null> {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    let e = this.snippets.get(key);
    if (!e) {
      const ctl = new AbortController();
      const entry: Snippet = {p: run(ctl.signal), ctl, users: 0};
      entry.p.then((v) => {
        entry.v = v;
      }, () => {
        if (this.snippets.get(key) === entry) this.snippets.delete(key);
      });
      this.snippets.set(key, entry);
      // Bound memory because each key retains the snippet text.
      for (const k of this.snippets.keys()) {
        if (this.snippets.size <= 300) break;
        this.snippets.delete(k);
      }
      e = entry;
    }
    const entry = e;
    entry.users++;
    if (!signal) return entry.p;
    return new Promise((resolve, reject) => {
      entry.p.then(resolve, reject);
      signal.addEventListener('abort', () => {
        reject(aborted(signal));
        if (--entry.users > 0 || entry.v !== undefined) return;
        // Forgotten at once, so that an asker coming right after starts afresh.
        if (this.snippets.get(key) === entry) this.snippets.delete(key);
        entry.ctl.abort(signal.reason);
      }, {once: true});
    });
  }

  /** Memory-only highlighting: undefined means a miss, null means plain. */
  peekHighlight(repoId: number, blobSha: string, path: string): Highlight | null | undefined {
    const lang = langOf(path);
    if (!lang) return null;
    return this.cache.peek(CodeSource.highlightKey(repoId, blobSha, lang));
  }

  /**
   * Relative links resolve from the file's directory at ref, root-relative links from the repo root.
   * Cached by blob and ref; callers must pass returned HTML through the Trusted Types gate.
   */
  rendered(repoId: number, blobSha: string, path: string, text: string, ref: {kind: RefKind; name: string}): Promise<string> {
    return this.cached(`md2:${String(repoId)}:${blobSha}:${ref.kind}:${ref.name}:${path}`, async () => {
      const body: APIMarkupRequest = {repo_id: repoId, ref: `${ref.kind}/${ref.name}`, path, text};
      const res = await this.request('sync', '/markup', undefined, body);
      return ((await readJson(res)) as APIMarkupResponse).html;
    });
  }

  /** Server reads the file at commit, avoiding separate tree/blob requests; returns untrusted HTML. */
  renderedAt(repoId: number, commit: string, path: string, ref: {kind: RefKind; name: string}): Promise<string> {
    return this.cached(CodeSource.renderedKey(repoId, commit, path, ref), async () => {
      const body: APIMarkupRequest = {repo_id: repoId, ref: `${ref.kind}/${ref.name}`, path, text: '', commit};
      const res = await this.request('sync', '/markup', undefined, body);
      return ((await readJson(res)) as APIMarkupResponse).html;
    });
  }

  static renderedKey(repoId: number, commit: string, path: string, ref: {kind: RefKind; name: string}): string {
    return `mdc:${String(repoId)}:${commit}:${ref.kind}:${ref.name}:${path}`;
  }

  static activityKey(repoId: number, commit: string): string {
    return `act:${String(repoId)}:${commit}`;
  }

  /** A year of activity ending at commit. */
  commitActivity(repoId: number, commit: string): Promise<APICommitActivity> {
    return this.cached(CodeSource.activityKey(repoId, commit), async () => {
      const res = await this.request('sync', `/repos/${String(repoId)}/activity/${commit}`);
      return await readJson(res) as APICommitActivity;
    });
  }

  static contributorsKey(repoId: number, commit: string): string {
    return `ctb:${String(repoId)}:${commit}`;
  }

  /** Polls background computation using Retry-After, deduplicated per commit. */
  contributors(repoId: number, commit: string): Promise<APIContributors> {
    return this.cached(CodeSource.contributorsKey(repoId, commit), async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await this.request('sync', `/repos/${String(repoId)}/contributors/${commit}`);
        if (res.status !== 202) return await readJson(res) as APIContributors;
        void res.body?.cancel();
        if (attempt >= CONTRIBUTOR_ATTEMPTS) throw new RequestFailed(503, 'Forgejo is still computing these statistics. Try again in a minute.');
        const after = Number(res.headers.get('Retry-After') ?? '2');
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(10, Math.max(1, Number.isFinite(after) ? after : 2))));
      }
    });
  }

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
      return (await readJson(res) as ApiCommit[]).map(commitInfo);
    });
  }

  commit(repoId: number, sha: string): Promise<CommitInfo> {
    return this.cached(`commit:${String(repoId)}:${sha}`, async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/git/commits/${sha}?stat=false&verification=false&files=false`);
      return commitInfo(await readJson(res) as ApiCommit);
    });
  }

  /** Resolves online every time: new commits can make abbreviations ambiguous. Caches by full SHA. */
  async resolveCommit(repoId: number, abbreviation: string): Promise<string> {
    if (!/^[0-9a-f]{4,64}$/i.test(abbreviation)) throw new RequestFailed(400, 'Not a commit SHA.');
    const res = await this.request('v1', `${this.repoPath(repoId)}/git/commits/${abbreviation}?stat=false&verification=false&files=false`);
    const info = commitInfo(await readJson(res) as ApiCommit);
    if (!isSha(info.sha) || !info.sha.startsWith(abbreviation.toLowerCase())) throw new RequestFailed(404, 'No such commit.');
    this.cache.put(`commit:${String(repoId)}:${info.sha}`, info);
    return info.sha;
  }

  /** Commits on `head` not on `base` (both full SHAs). */
  compare(repoId: number, base: string, head: string): Promise<CompareInfo> {
    return this.cached(`compare:${String(repoId)}:${base}:${head}`, async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/compare/${base}...${head}`);
      const j = await readJson(res) as {total_commits?: number; commits?: ApiCommit[] | null};
      const commits = (j.commits ?? []).map(commitInfo);
      return {commits, total: j.total_commits ?? commits.length};
    });
  }

  static pathsKey(repoId: number, commit: string): string {
    return `paths:${String(repoId)}:${commit}`;
  }

  /** Cached recursive blob paths, bounded by MAX_TREE_PAGES; reports truncation. */
  paths(repoId: number, commit: string): Promise<PathList> {
    return this.cached(CodeSource.pathsKey(repoId, commit), async () => {
      const page = async (n: number) => {
        const res = await this.request('v1', `${this.repoPath(repoId)}/git/trees/${commit}?recursive=true&per_page=100000&page=${String(n)}`);
        return await readJson(res) as ApiTree;
      };
      const first = await page(1);
      const per = first.tree?.length ?? 0;
      const total = first.total_count ?? per;
      const pages = first.truncated && per > 0 ? Math.ceil(total / per) : 1;
      const asked = Math.min(pages, MAX_TREE_PAGES);
      const rest: ApiTree[] = [];
      // Bound concurrency to avoid a burst of requests for large trees.
      for (let n = 2; n <= asked; n += TREE_PAGES_AT_ONCE) {
        const batch = Array.from({length: Math.min(TREE_PAGES_AT_ONCE, asked - n + 1)}, (_, i) => page(n + i));
        rest.push(...await Promise.all(batch));
      }
      const paths: string[] = [];
      for (const t of [first, ...rest]) for (const e of t.tree ?? []) if (e.type === 'blob') paths.push(e.path);
      return {paths, truncated: pages > asked};
    });
  }

  static languagesKey(repoId: number, commit: string): string {
    return `langs:${String(repoId)}:${commit}`;
  }

  /** Language name → bytes; empty answers are not cached because computation may be pending. */
  languages(repoId: number, commit: string): Promise<Record<string, number>> {
    return this.cached(CodeSource.languagesKey(repoId, commit), async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/languages`);
      return await readJson(res) as Record<string, number>;
    }, (v) => Object.keys(v).length > 0);
  }

  close(): void {
    this.off();
    this.cache.close();
    this.hl.close();
  }
}

interface Snippet {
  p: Promise<Highlight | null>;
  /** The result once settled. */
  v?: Highlight | null;
  ctl: AbortController;
  /** Askers still waiting; those without a signal never stop waiting. */
  users: number;
}

function diffSnippetKey(lang: Lang, f: DiffFile): string {
  return `dsnip:${lang}:${f.lines.map((l) => `${l.k === DEL ? '-' : '+'}${l.t}`).join('\n')}`;
}

const sources = new WeakMap<Session, CodeSource>();

/** Lazily creates one source per session; undefined without a session. */
export function codeSource(app: App): CodeSource | undefined {
  const s = app.session;
  if (!s) return undefined;
  let src = sources.get(s);
  if (!src) sources.set(s, src = new CodeSource(app, s));
  return src;
}
