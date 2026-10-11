// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The code worker's highlighter as the page drives it (PLAN §5.1, §5.7): one
// worker, one highlight at a time, a watchdog, and two priorities.
//
//   * The watchdog stops a highlight that makes no progress. A TextMate
//     grammar can backtrack for minutes on crafted text (a file in a pull
//     request); the worker reports each chunk of lines it tokenized
//     (workers/highlight.ts), and a highlight without a report for
//     LIMITS.stall is stopped: the worker is terminated (the next highlight
//     starts another) and the call rejects with TimedOut. A long file on a
//     slow device is not stopped as long as it is getting on — a limit on
//     the whole highlight made every file of a few hundred lines plain on
//     slower machines (the patterns of a grammar are compiled while the
//     first lines are tokenized), while a diff's few lines per file still
//     made it, and each stop started the next file in a cold worker again.
//   * "now": what is on screen (a file, a diff's files, a code block), in
//     order. "idle": what may be wanted next (a hovered file, a prefetched
//     pull request's grammars) runs only when nothing is waiting "now",
//     newest first, and only the last few wait (the pointer moved on: older
//     intents are dropped with Superseded). A view asking for a key that waits
//     "idle" promotes it.
//
// Pure of the DOM: the worker is behind HighlightWorker (workerHighlighter
// wraps a real one), so tests drive it with fakes and fake timers.

import {type Remote, wrap} from 'comlink';
import type {CodeWorkerApi, Highlight} from '../workers/code.worker.ts';
import type {Lang} from './lang.ts';

/** The message the worker posts after each chunk of lines it tokenized. */
export const PROGRESS = 'forgejo-next:highlight-progress';

export const LIMITS = {
  /** Starting the worker and loading a grammar longer than this fails the highlight (not cached: asked again). */
  prepare: 30_000,
  /** A highlight without progress for this long is stopped (a chunk takes well under a second on a slow phone). */
  stall: 10_000,
};

/** Intents waiting at most (the newest). */
const IDLE_MAX = 4;

export type Priority = 'now' | 'idle';

/** A highlight stopped by the watchdog (callers keep the text plain for the session: it would run away again). */
export class TimedOut extends Error {
  override name = 'TimedOut';
}

/** An idle highlight dropped for newer intents (not an error to show: nothing asked for it on screen). */
export class Superseded extends Error {
  override name = 'Superseded';
}

export type WorkerApi = Pick<Remote<CodeWorkerApi>, 'prepare' | 'highlight' | 'highlightDiffFile'>;

/** The worker as the highlighter sees it. */
export interface HighlightWorker {
  api: WorkerApi;
  /** Rejects when the worker fails or is stopped. */
  failed: Promise<never>;
  stop(): void;
  /** The function called on each progress report of the worker (undefined: none). */
  onProgress(fn: (() => void) | undefined): void;
}

/** A HighlightWorker over a real code worker. */
export function workerHighlighter(w: Worker): HighlightWorker {
  let fail: (err: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);
  let progress: (() => void) | undefined;
  w.addEventListener('message', (ev: MessageEvent<unknown>) => {
    if (ev.data === PROGRESS) progress?.();
  });
  const stop = () => {
    w.terminate();
    fail(new Error('The highlighter stopped.'));
  };
  // A worker that fails to load (a build replaced under the page) never answers: calls fail now, the next starts another.
  w.addEventListener('error', stop);
  return {
    api: wrap<CodeWorkerApi>(w), failed, stop, onProgress: (fn) => {
      progress = fn;
    },
  };
}

interface Job {
  key: string | undefined;
  exec: (w: HighlightWorker) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (err: unknown) => void;
}

export class Highlighter {
  private worker: HighlightWorker | undefined;
  private busy = false;
  private closed = false;
  private readonly now: Job[] = [];
  private readonly idle: Job[] = [];
  /** Keys asked for "now" before their idle job was queued (the cache lookup comes first). */
  private readonly urgent = new Set<string>();
  private readonly spawn: () => HighlightWorker;
  private readonly limits: typeof LIMITS;

  constructor(spawn: () => HighlightWorker, limits: typeof LIMITS = LIMITS) {
    this.spawn = spawn;
    this.limits = limits;
  }

  /** Starts the worker now (it takes a moment to boot): a page about to show code does not wait for it afterwards. */
  preheat(): void {
    if (!this.closed) this.current();
  }

  /** Runs a highlight in the worker, watched (see the top of this file). `key` names it for promote. */
  highlight(lang: Lang, run: (api: WorkerApi) => Promise<Highlight | null>, opts: {priority?: Priority; key?: string} = {}): Promise<Highlight | null> {
    return this.enqueue(opts.key, opts.priority ?? 'now', (w) => this.watched(w, lang, run)) as Promise<Highlight | null>;
  }

  /**
   * Loads a grammar into the worker, idle: its chunk is then in the service worker's cache (grammars are cached on
   * first use), so a prefetched pull request is highlighted offline too.
   */
  warm(lang: Lang): Promise<void> {
    return this.enqueue(undefined, 'idle', (w) => this.prepare(w, lang, false)) as Promise<void>;
  }

  /** A view wants `key` now: its idle highlight (queued, or about to be) moves to the "now" queue. */
  promote(key: string): void {
    const i = this.idle.findIndex((j) => j.key === key);
    if (i >= 0) {
      this.now.push(...this.idle.splice(i, 1));
      return;
    }
    this.urgent.add(key);
    // (keys whose highlight never comes — a cache hit — are forgotten in time)
    for (const k of this.urgent) {
      if (this.urgent.size <= 64) break;
      this.urgent.delete(k);
    }
  }

  /** Stops the worker and fails what waits. */
  close(): void {
    this.closed = true;
    if (this.worker) this.kill(this.worker);
    for (const j of [...this.now.splice(0), ...this.idle.splice(0)]) j.reject(new Error('The highlighter is closed.'));
  }

  private enqueue(key: string | undefined, priority: Priority, exec: (w: HighlightWorker) => Promise<unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The highlighter is closed.'));
    return new Promise((resolve, reject) => {
      const job: Job = {key, exec, resolve, reject};
      if (priority === 'now' || (key !== undefined && this.urgent.delete(key))) this.now.push(job);
      else {
        this.idle.push(job);
        while (this.idle.length > IDLE_MAX) this.idle.shift()?.reject(new Superseded('A newer intent came first.'));
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy || this.closed) return;
    // Idle: the newest intent first.
    const job = this.now.shift() ?? this.idle.pop();
    if (!job) return;
    this.busy = true;
    job.exec(this.current()).then(job.resolve, job.reject).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private current(): HighlightWorker {
    if (this.worker) return this.worker;
    const w = this.spawn();
    this.worker = w;
    w.failed.catch(() => {
      if (this.worker === w) this.worker = undefined;
    });
    return w;
  }

  private kill(w: HighlightWorker): void {
    if (this.worker === w) this.worker = undefined;
    w.stop();
  }

  /** Starts Shiki and loads the grammar (not timed as a highlight); `strict`: failing to in time stops the worker and rejects. */
  private async prepare(w: HighlightWorker, lang: Lang, strict: boolean): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([w.api.prepare(lang), w.failed, new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, this.limits.prepare);
      })]);
      if (r === 'timeout' && strict) {
        this.kill(w);
        throw new Error('The highlighter did not start.');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async watched(w: HighlightWorker, lang: Lang, run: (api: WorkerApi) => Promise<Highlight | null>): Promise<Highlight | null> {
    await this.prepare(w, lang, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<'stalled'>((resolve) => {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          resolve('stalled');
        }, this.limits.stall);
      };
      w.onProgress(arm);
      arm();
    });
    try {
      const r = await Promise.race([run(w.api), w.failed, stalled]);
      if (r !== 'stalled') return r;
      this.kill(w);
      throw new TimedOut('The highlight made no progress.');
    } finally {
      clearTimeout(timer);
      w.onProgress(undefined);
    }
  }
}
