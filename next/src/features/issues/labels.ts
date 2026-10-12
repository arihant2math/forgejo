// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo's exclusive scope ends at the final slash; statuses and priorities use ranked values.

import type {Label} from '../../protocol/types.gen.ts';

export type ScopeKind = 'status' | 'priority';

/** Empty string when the label has no exclusive scope. */
export function exclusiveScope(l: Pick<Label, 'name' | 'exclusive'>): string {
  if (!l.exclusive) return '';
  const i = l.name.lastIndexOf('/');
  if (i <= 0 || i === l.name.length - 1) return '';
  return l.name.slice(0, i);
}

export function scopedValue(name: string): string {
  const i = name.lastIndexOf('/');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : name;
}

const KINDS: Record<string, ScopeKind> = {status: 'status', state: 'status', workflow: 'status', stage: 'status', priority: 'priority', prio: 'priority'};

export function scopeKind(scope: string): ScopeKind | undefined {
  if (!scope) return undefined;
  const last = scope.slice(scope.lastIndexOf('/') + 1).trim().toLowerCase();
  return KINDS[last];
}

export function labelKind(l: Pick<Label, 'name' | 'exclusive'>): ScopeKind | undefined {
  return scopeKind(exclusiveScope(l));
}

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

export type StatusStage = 'backlog' | 'todo' | 'started' | 'review' | 'done' | 'canceled';

const STAGES: [RegExp, StatusStage][] = [
  [/^(backlog|triage|icebox|new|needs triage|proposal|idea)/, 'backlog'],
  [/^(todo|to do|ready|planned|open|accepted|confirmed)/, 'todo'],
  [/^(in progress|doing|wip|started|active|in development|implementing|working)/, 'started'],
  [/^(in review|review|needs review|testing|qa|blocked)/, 'review'],
  [/^(done|closed|complete|completed|fixed|resolved|shipped|released|merged)/, 'done'],
  [/^(canceled|cancelled|wontfix|won t fix|won't fix|duplicate|invalid|rejected|obsolete)/, 'canceled'],
];

const STAGE_RANK: Record<StatusStage, number> = {backlog: 0, todo: 1, started: 2, review: 3, done: 4, canceled: 5};

export function statusStage(value: string): StatusStage | undefined {
  const v = norm(value);
  for (const [re, stage] of STAGES) if (re.test(v)) return stage;
  return undefined;
}

/** Unknown status values sort between in-progress and review. */
export function statusRank(value: string): number {
  const s = statusStage(value);
  return s === undefined ? 2.5 : STAGE_RANK[s];
}

/** 0 is urgent, 4 is none; unknown values rank in the middle. P0–P4 use the same ranks. */
export function priorityRank(value: string): number {
  const v = norm(value);
  const p = /^p([0-4])$/.exec(v);
  if (p) return Number(p[1]);
  if (/^(urgent|critical|blocker|highest|emergency|showstopper)/.test(v)) return 0;
  if (/^(high|important|major)/.test(v)) return 1;
  if (/^(medium|normal|moderate|default)/.test(v)) return 2;
  if (/^(low|minor)/.test(v)) return 3;
  if (/^(lowest|none|trivial|no priority|someday)/.test(v)) return 4;
  return 2;
}

/** Lower ranks sort first. */
export function kindRank(kind: ScopeKind, name: string): number {
  return kind === 'status' ? statusRank(scopedValue(name)) : priorityRank(scopedValue(name));
}
