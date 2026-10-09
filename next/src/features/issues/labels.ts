// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Scoped labels as Linear-like fields (PLAN §7.3): an exclusive scoped label
// `status/…` is an issue's workflow status, `priority/…` its priority. The
// scope is what Forgejo calls it (models/issues/label.go ExclusiveScope:
// the name up to its last "/", for exclusive labels only); the value's rank
// orders statuses and priorities by common names, unknown names in between.

import type {Label} from '../../protocol/types.gen.ts';

export type ScopeKind = 'status' | 'priority';

/** Forgejo's exclusive scope of a label ("" when it has none). */
export function exclusiveScope(l: Pick<Label, 'name' | 'exclusive'>): string {
  if (!l.exclusive) return '';
  const i = l.name.lastIndexOf('/');
  if (i <= 0 || i === l.name.length - 1) return '';
  return l.name.slice(0, i);
}

/** The value part of a scoped label's name ("status/In progress" → "In progress"). */
export function scopedValue(name: string): string {
  const i = name.lastIndexOf('/');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : name;
}

const KINDS: Record<string, ScopeKind> = {status: 'status', state: 'status', workflow: 'status', stage: 'status', priority: 'priority', prio: 'priority'};

/** Whether a scope is a status or priority scope ("Status", "kind/status" → status). */
export function scopeKind(scope: string): ScopeKind | undefined {
  if (!scope) return undefined;
  const last = scope.slice(scope.lastIndexOf('/') + 1).trim().toLowerCase();
  return KINDS[last];
}

/** The kind of an exclusive scoped label, if it is a status or priority. */
export function labelKind(l: Pick<Label, 'name' | 'exclusive'>): ScopeKind | undefined {
  return scopeKind(exclusiveScope(l));
}

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/** Workflow order of a status value: backlog → todo → in progress → review → done → canceled. */
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

/** Sort rank of a status value (unknown names between "in progress" and "review"). */
export function statusRank(value: string): number {
  const s = statusStage(value);
  return s === undefined ? 2.5 : STAGE_RANK[s];
}

/** Urgency of a priority value: 0 urgent … 4 none; unknown names in the middle. "P0"…"P4" count as such. */
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

/** The rank used to order labels of one kind (lower first). */
export function kindRank(kind: ScopeKind, name: string): number {
  return kind === 'status' ? statusRank(scopedValue(name)) : priorityRank(scopedValue(name));
}
