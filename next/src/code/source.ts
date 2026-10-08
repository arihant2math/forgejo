// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Where code views get git content (PLAN §5.5, §5.7): one CodeSource per
// session. Every read is addressed by SHA — B9's immutable endpoints for
// trees, blobs, blames and diffs; API v1 for commit lists and compares of
// full SHAs — so an answer is cached forever (cache.ts) and a cached answer
// never needs the network: views that were seen once work offline.
// Highlighting goes to the code worker (Comlink). Diffs are parsed here: the
// parse is a few ms per 5k lines, and a parsed diff (an object per line)
// coming back from a worker costs the main thread 3-4x that to deserialize.
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
import {type DiffFile, filePath, parseDiff} from './diff.ts';
import {HIGHLIGHT_MAX_CHARS, type Lang, langOf} from './lang.ts';

export type {Highlight} from '../workers/code.worker.ts';

/** Files above this size are not fetched for display (the classic UI's raw link is offered). */
export const MAX_FILE = 4 * 1024 * 1024;

/**
 * Diffs above this size are not shown (nor cached, nor prefetched): B9 streams
 * diffs without a limit, and one would be parsed, held and stored several
 * times over (the classic UI caps diffs too).
 */
export const MAX_DIFF = 8 * 1024 * 1024;

/**
 * A highlight running longer than this is stopped (the text stays plain): 4 s
 * plus 2 ms a line, at most 20 s (a 5k-line TypeScript file takes ≈ 7 s in
 * this worker; a runaway grammar spins far longer).
 */
function highlightLimit(lines: number): number {
  return Math.min(20_000, 4000 + 2 * lines);
}

/** A highlight stopped by the watchdog. */
class TimedOut extends Error {
  override name = 'TimedOut';
}

/** Starting the worker and loading a grammar longer than this fails the highlight (not cached: asked again). */
const PREPARE_LIMIT = 30_000;

/** Content too large to show here (status 413 for the views). */
export class TooLarge extends RequestFailed {
  override name = 'TooLarge';
  constructor(what: string) {
    super(413, `${what} is too large to show here.`);
  }
}

/** JSON answers (trees, blames, commit lists, compares) above this are refused: unrelated histories compare to every commit. */
const MAX_JSON = 16 * 1024 * 1024;

/** Reads a JSON answer, stopping (TooLarge) beyond MAX_JSON. */
async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await readCapped(res, MAX_JSON));
}

/** Reads a text answer, stopping (TooLarge) beyond `max` bytes. */
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
  /** The highlighter (stopped and replaced when a highlight runs away or the worker fails). */
  private highlighter: Highlighter | undefined;
  /** The highlights waiting their turn (one runs at a time: see watched). */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Diffs parsed this session (key → files). */
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

  private spawn(): Highlighter {
    const at = workerUrl.indexOf('assets/');
    const url = at >= 0 ? `${this.app.config.base}${workerUrl.slice(at)}` : workerUrl;
    const w = new Worker(appWorkerURL(this.app.config.base, url), {type: 'module', name: 'code-highlight'});
    let fail: (err: Error) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    failed.catch(() => undefined);
    const h: Highlighter = {w, api: wrap<CodeWorkerApi>(w), failed, stop: () => {
      if (this.highlighter === h) this.highlighter = undefined;
      w.terminate();
      fail(new Error('The highlighter stopped.'));
    }};
    // A worker that fails to load (a build replaced under the page) never answers: calls fail now, the next starts another.
    w.addEventListener('error', () => {
      h.stop();
    });
    return h;
  }

  /**
   * Runs a highlight with a watchdog: a TextMate grammar can backtrack for
   * minutes on crafted text (a file in a pull request). Highlights run one at
   * a time, and the clock starts once the worker and the grammar are ready,
   * so only tokenizing is timed (not starting Shiki, a slow grammar chunk, or
   * waiting behind other files). Past HIGHLIGHT_LIMIT the highlighter is
   * terminated (a new one starts with the next call) and the call rejects
   * with TimedOut (callers keep the text plain for this session: it would run
   * away again; not stored, a faster device may manage). A failure (a grammar or the
   * worker not loading in PREPARE_LIMIT, the worker failing) rejects: not
   * cached, asked again later.
   */
  private watched(lang: Lang, lines: number, run: (api: Remote<CodeWorkerApi>) => Promise<Highlight | null>): Promise<Highlight | null> {
    const p = this.queue.then(() => this.watchedNow(lang, lines, run));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async watchedNow(lang: Lang, lines: number, run: (api: Remote<CodeWorkerApi>) => Promise<Highlight | null>): Promise<Highlight | null> {
    this.highlighter ??= this.spawn();
    const h = this.highlighter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const after = <T>(ms: number, v: T) => new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        resolve(v);
      }, ms);
    });
    try {
      if (await Promise.race([h.api.prepare(lang), h.failed, after(PREPARE_LIMIT, 'timeout' as const)]) === 'timeout') {
        h.stop();
        throw new Error('The highlighter did not start.');
      }
      clearTimeout(timer);
      const r = await Promise.race([run(h.api), h.failed, after(highlightLimit(lines), 'timeout' as const)]);
      if (r !== 'timeout') return r;
      h.stop();
      throw new TimedOut('The highlight took too long.');
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
        msg = (await readJson(res) as {message?: string}).message ?? '';
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
      return await readJson(res) as APITree;
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

  /** Whether a diff is on this device (prefetched or seen; its text is not read). */
  hasDiff(repoId: number, base: string, head: string): Promise<boolean> {
    return this.cache.has(CodeSource.diffKey(repoId, base, head));
  }

  /** The diff parsed (once per session and diff). */
  diff(repoId: number, base: string, head: string): Promise<DiffFile[]> {
    const key = CodeSource.diffKey(repoId, base, head);
    let p = this.parsed.get(key);
    if (!p) {
      p = this.diffText(repoId, base, head).then(parseDiff);
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
    const key = CodeSource.diffHlKey(repoId, base, head, index);
    const hit = this.cache.peek<Highlight | null>(key);
    if (hit !== undefined) return hit;
    const file = (await this.diff(repoId, base, head))[index];
    const lang = file && langOf(filePath(file));
    if (!file || !lang) return null;
    let h: Highlight | null;
    try {
      h = await this.watched(lang, file.lines.length, (api) => api.highlightDiffFile(file));
    } catch (err) {
      if (!(err instanceof TimedOut)) throw err;
      h = null;
    }
    // In memory: a diff opened again in this session paints highlighted (not stored: cheap to redo).
    this.cache.remember(key, h);
    return h;
  }

  static diffHlKey(repoId: number, base: string, head: string, index: number): string {
    return `dhl:${String(repoId)}:${base}:${head}:${String(index)}`;
  }

  /** A diff file's highlighting already in memory. */
  peekDiffHighlight(repoId: number, base: string, head: string, index: number): Highlight | null | undefined {
    return this.cache.peek(CodeSource.diffHlKey(repoId, base, head, index));
  }

  /** A file's highlighting, cached by blob SHA (null: plain). */
  highlight(repoId: number, blobSha: string, path: string, text: string): Promise<Highlight | null> {
    const lang = langOf(path);
    if (!lang || text.length > HIGHLIGHT_MAX_CHARS) return Promise.resolve(null);
    const key = `hl:${String(repoId)}:${blobSha}:${lang}`;
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    return this.cached(key, () => this.watched(lang, lines, (api) => api.highlight(text, lang))).catch((err: unknown) => {
      if (!(err instanceof TimedOut)) throw err;
      // Plain for this session (it would run away again), not stored.
      this.cache.remember(key, null);
      return null;
    });
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
      return (await readJson(res) as ApiCommit[]).map(commitInfo);
    });
  }

  commit(repoId: number, sha: string): Promise<CommitInfo> {
    return this.cached(`commit:${String(repoId)}:${sha}`, async () => {
      const res = await this.request('v1', `${this.repoPath(repoId)}/git/commits/${sha}?stat=false&verification=false&files=false`);
      return commitInfo(await readJson(res) as ApiCommit);
    });
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

  close(): void {
    this.off();
    this.cache.close();
    this.highlighter?.stop();
  }
}

interface Highlighter {
  w: Worker;
  api: Remote<CodeWorkerApi>;
  /** Rejects when the worker fails or is stopped. */
  failed: Promise<never>;
  stop: () => void;
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
