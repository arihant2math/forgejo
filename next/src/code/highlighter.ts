// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// TextMate grammars can backtrack on crafted text. Stop stalled workers,
// not long-running highlights that keep reporting progress.
// Visible work runs FIFO; bounded idle work runs newest-first. Work a view no longer
// wants is dropped from the queue (a running highlight still finishes: the worker cannot be interrupted).

import {type Remote, wrap} from 'comlink';
import type {CodeWorkerApi, Highlight} from '../workers/code.worker.ts';
import type {Lang} from './shiki.ts';

/** The message the worker posts after each chunk of lines it tokenized. */
export const PROGRESS = 'forgejo-next:highlight-progress';

export const LIMITS = {
  /** Worker/grammar startup timeout in milliseconds; failures are not cached, so later requests retry. */
  prepare: 30_000,
  /** Maximum time without progress, in milliseconds. */
  stall: 10_000,
};

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

/** The error an abort rejects with. */
export function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The highlight is no longer wanted.', 'AbortError');
}

export type WorkerApi = Pick<Remote<CodeWorkerApi>, 'prepare' | 'highlight' | 'highlightDiffFile'>;

export interface HighlightWorker {
  api: WorkerApi;
  /** Rejects when the worker fails or is stopped. */
  failed: Promise<never>;
  stop(): void;
  /** The function called on each progress report of the worker (undefined: none). */
  onProgress(fn: (() => void) | undefined): void;
}

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
  // Load failures never answer Comlink calls; reject them and allow a fresh worker.
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
  /** Promotions can precede enqueueing because cache lookup comes first. */
  private readonly urgent = new Set<string>();
  private readonly spawn: () => HighlightWorker;
  private readonly limits: typeof LIMITS;

  constructor(spawn: () => HighlightWorker, limits: typeof LIMITS = LIMITS) {
    this.spawn = spawn;
    this.limits = limits;
  }

  /**
   * Rejects stalled work; key identifies pending work for promote(). An abort rejects at once with the signal's
   * reason and drops the job if it has not started.
   */
  highlight(lang: Lang, run: (api: WorkerApi) => Promise<Highlight | null>, opts: {priority?: Priority; key?: string; signal?: AbortSignal | undefined} = {}): Promise<Highlight | null> {
    return this.enqueue(opts.key, opts.priority ?? 'now', (w) => this.watched(w, lang, run), opts.signal) as Promise<Highlight | null>;
  }

  /** Loads a grammar at idle priority, caching its chunk for offline highlighting. */
  warm(lang: Lang): Promise<void> {
    return this.enqueue(undefined, 'idle', (w) => this.prepare(w, lang, false), undefined) as Promise<void>;
  }

  /** A view wants `key` now: its idle highlight (queued, or about to be) moves to the "now" queue. */
  promote(key: string): void {
    const i = this.idle.findIndex((j) => j.key === key);
    if (i >= 0) {
      this.now.push(...this.idle.splice(i, 1));
      return;
    }
    this.urgent.add(key);
    // Bound promotions whose jobs never arrive because of cache hits.
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

  private enqueue(key: string | undefined, priority: Priority, exec: (w: HighlightWorker) => Promise<unknown>, signal: AbortSignal | undefined): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The highlighter is closed.'));
    if (signal?.aborted) return Promise.reject(aborted(signal));
    return new Promise((resolve, reject) => {
      const drop = () => {
        for (const q of [this.now, this.idle]) {
          const i = q.indexOf(job);
          if (i >= 0) q.splice(i, 1);
        }
        if (signal) reject(aborted(signal));
      };
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        signal?.removeEventListener('abort', drop);
        fn(v);
      };
      const job: Job = {key, exec, resolve: settle(resolve), reject: settle(reject)};
      signal?.addEventListener('abort', drop, {once: true});
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
    const job = this.now.shift() ?? this.idle.pop();
    if (!job) return;
    let w: HighlightWorker;
    try {
      w = this.current();
    } catch (err) {
      // No worker to be had (an engine without workers): fail this job, not the queue.
      job.reject(err);
      this.pump();
      return;
    }
    this.busy = true;
    job.exec(w).then(job.resolve, job.reject).finally(() => {
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
