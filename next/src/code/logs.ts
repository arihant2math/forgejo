// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Log messages may overlap or leave gaps. Each task has its own offsets.

import type {LogLine, LogMessage, LogStep} from '../protocol/types.gen.ts';

export interface LogState {
  taskId: number;
  lines: LogLine[];
  steps: LogStep[];
  done: boolean;
  expired: boolean;
}

export function emptyLog(): LogState {
  return {taskId: 0, lines: [], steps: [], done: false, expired: false};
}

export type ApplyResult =
  /** Applied; `added` lines appended (0: a repeat), `reset`: another task replaced the lines. */
  | {ok: true; added: number; reset: boolean}
  /** A gap: lines from `from` are missing (ask for them: log_tail with task_id and offset). */
  | {ok: false; from: number};

/** Applies one message to the state (mutates it). */
export function applyLog(s: LogState, m: Pick<LogMessage, 'task_id' | 'offset' | 'lines' | 'steps' | 'done' | 'expired'>): ApplyResult {
  let reset = false;
  if (m.task_id !== s.taskId) {
    // Ignore late repeats from older tasks; 0 means waiting for a runner.
    if (m.task_id === 0 || (s.taskId !== 0 && m.task_id < s.taskId)) return {ok: true, added: 0, reset: false};
    s.taskId = m.task_id;
    s.lines = [];
    s.steps = [];
    s.done = false;
    s.expired = false;
    reset = true;
  }
  if (m.offset > s.lines.length) return {ok: false, from: s.lines.length};
  const skip = s.lines.length - m.offset;
  let added = 0;
  for (let i = skip; i < m.lines.length; i++) {
    const l = m.lines[i];
    if (l) {
      s.lines.push(l);
      added++;
    }
  }
  if (m.steps) s.steps = m.steps;
  // Done only counts once every line is here (a repeated done after a gap would lie).
  if (m.done && m.offset + m.lines.length >= s.lines.length) s.done = true;
  if (m.expired) s.expired = true;
  return {ok: true, added, reset};
}

export function finished(status: string): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled' || status === 'skipped';
}
