// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One job's log for a view (F7): the cached copy of a finished task, else the
// live tail over the sync session (B9, through the leader tab), merged by
// offset (code/logs.ts). Finished logs are kept by (job, task).

import {applyLog, emptyLog, finished, type LogState} from './logs.ts';
import type {ActionRunJob, LogLine, LogStep} from '../protocol/types.gen.ts';
import type {CodeSource} from './source.ts';
import type {Data} from '../sync/data.ts';

/** A finished job's log as cached (by job and task). */
export interface StoredLog {
  taskId: number;
  lines: LogLine[];
  steps: LogStep[];
  expired: boolean;
}

export const logKey = (repoId: number, jobId: number, taskId: number) => `log:${String(repoId)}:${String(jobId)}:${String(taskId)}`;

/**
 * A job's log: the cached copy of a finished task, else the live tail over
 * the sync session (merged by offset: repeats dropped, gaps asked for again).
 * Listeners hear at most once a frame however fast lines arrive.
 */
export class LogFeed {
  readonly log: LogState = emptyLog();
  source: 'cache' | 'live' | 'none' = 'none';
  /** The server ended the tail (forbidden, too many tails, an error). */
  closed: string | undefined;
  private version = 0;
  private frame = 0;
  private readonly listeners = new Set<() => void>();
  private readonly data: Data;
  private readonly src: CodeSource;
  private readonly repoId: number;
  private readonly job: ActionRunJob;

  constructor(data: Data, src: CodeSource, repoId: number, job: ActionRunJob) {
    this.data = data;
    this.src = src;
    this.repoId = repoId;
    this.job = job;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly snapshot = (): number => this.version;

  private paint(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.version++;
      for (const fn of this.listeners) fn();
    });
  }

  /** Loads (cache) or tails (live, when online); returns the stop. */
  start(online: boolean): () => void {
    let live = true;
    const isLive = () => live;
    let untail: (() => void) | undefined;
    let retail: ReturnType<typeof setTimeout> | undefined;
    const {data, job, log} = this;
    const tail = () => {
      untail?.();
      this.source = 'live';
      untail = data.tailLog(job.id, log.taskId ? {taskId: log.taskId, offset: log.lines.length} : undefined, (msg) => {
        if (msg.type === 'log_closed') {
          untail?.();
          untail = undefined;
          this.closed = msg.reason;
          this.paint();
          return;
        }
        // A gap (this tab joined late, a message of an earlier tail still on its way): ask again from the
        // lines held — once, a moment later (never from inside this callback: messages keep coming meanwhile).
        if (!applyLog(log, msg).ok) {
          retail ??= setTimeout(() => {
            retail = undefined;
            if (isLive()) tail();
          }, 250);
          return;
        }
        if (log.done && log.taskId === job.task_id) {
          this.src.cache.put(logKey(this.repoId, job.id, log.taskId), {taskId: log.taskId, lines: log.lines, steps: log.steps, expired: log.expired} satisfies StoredLog);
        }
        this.paint();
      });
    };
    void (async () => {
      if (finished(job.status) && job.task_id) {
        const cached = await this.src.cache.get<StoredLog>(logKey(this.repoId, job.id, job.task_id));
        if (!isLive()) return;
        if (cached) {
          Object.assign(log, {taskId: cached.taskId, lines: cached.lines, steps: cached.steps, done: true, expired: cached.expired});
          this.source = 'cache';
          this.paint();
          return;
        }
      }
      if (online) tail();
      else this.paint();
    })();
    return () => {
      live = false;
      clearTimeout(retail);
      untail?.();
    };
  }

  close(): void {
    cancelAnimationFrame(this.frame);
  }
}
