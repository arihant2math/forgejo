// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Bootstrap replacement (protocol.BootstrapHeader, "Replacement"): once a
// response's end line arrived, drop every entity of the group within the
// response's scope with v at or below the watermark that the response did
// not contain. The scope rules are the server's contract, implemented here
// exactly (B6 notes, review round 1 item 3):
//
//   * full / summary: the whole group (only the header's models when it lists
//     some), except what the tier leaves out and cannot send again —
//       - summary: the closed tier (Issues held as closed with updated_at
//         before closed_before and their IssueLabel / IssueAssignee /
//         ProjectIssue / PullRequest, the AutoMerge of such a PullRequest)
//         and CommitStatus / ActionRun / ActionRunJob with updated_at before
//         closed_before;
//       - user:{id} (closed_before set): Notifications held as read with
//         updated_at before closed_before;
//     — unless the header's units differ from the units the group was held
//     with: then the scope is the whole group.
//   * closed page: Issues held as closed (before the summary's cutoff) whose
//     (updated_at, id) is below the page's `before` and at or above `next`,
//     what hangs off them, and what hangs off the page's own Issues.
//
// Decided on the entities as held after the response's lines were applied.

import type {Entity} from '../data/entity.ts';
import type {ModelName} from '../data/models.ts';
import type {Pool} from '../data/pool.ts';
import type {BootstrapEnd, BootstrapHeader} from '../protocol/types.gen.ts';

/** Unix seconds of an RFC 3339 time (what the server compares cursors with). */
export function unixSeconds(t: string | undefined): number {
  if (!t) return Number.NaN;
  return Math.floor(Date.parse(t) / 1000);
}

/** A closed-tier cursor: "<unix>" or "<unix>.<id>" (materialize.ClosedCursor). */
export interface Cursor {
  updated: number;
  id: number;
}

export function parseCursor(s: string): Cursor | undefined {
  const m = /^([1-9][0-9]*)(?:\.([1-9][0-9]*))?$/.exec(s);
  if (!m?.[1]) return undefined;
  return {updated: Number(m[1]), id: m[2] ? Number(m[2]) : 0};
}

/** (updated, id) < cursor, as the server orders the closed tier. */
export function below(updated: number, id: number, c: Cursor): boolean {
  return updated < c.updated || (updated === c.updated && id < c.id);
}

export function sameUnits(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((u) => s.has(u));
}

/** Models that hang off an issue through issue_id. */
const ISSUE_CHILDREN = new Set<ModelName>(['IssueLabel', 'IssueAssignee', 'ProjectIssue', 'PullRequest']);
const AGED = new Set<ModelName>(['CommitStatus', 'ActionRun', 'ActionRunJob']);

export interface ReplaceInput {
  group: string;
  header: BootstrapHeader;
  end: BootstrapEnd;
  /** The ids of the group's own entities the response contained, per model. */
  received: ReadonlyMap<string, ReadonlySet<number>>;
  /** The units the group was held with before (undefined: never loaded). */
  heldUnits: readonly string[] | undefined;
  /** For a closed page: the summary's closed_before the group is held with. */
  summaryClosedBefore?: number | undefined;
}

/**
 * Applies the replacement and sets the group's floor (Pool.setFloor) for a
 * full or summary response; returns the number of entities dropped.
 */
export function replaceGroup(pool: Pool, input: ReplaceInput): number {
  const {group, header, received} = input;
  const w = header.watermark;
  const models = header.models?.length ? new Set(header.models) : undefined;
  const held = [...pool.groupEntities(group)];
  const inScope = scopeOf(held, input, models);
  let dropped = 0;
  pool.batch(() => {
    for (const e of held) {
      if (e._v > w || e._g !== group) continue;
      if (!inScope(e)) continue;
      if (received.get(e.model)?.has(e.id)) continue;
      if (pool.evict(e.model, e.id, group, w)) dropped++;
    }
  });
  if (header.tier !== 'closed') {
    const unitsChanged = input.heldUnits !== undefined && !sameUnits(input.heldUnits, header.units);
    const cutoff = header.closed_before;
    pool.setFloor(group, w, header.models ?? undefined, cutoff === undefined || unitsChanged ? undefined : (m, d) => outOfScope(pool, m, d, cutoff));
  }
  return dropped;
}

/** Whether a state is in the part of a group a summary (or user bootstrap) leaves out: the closed tier, old read notifications. */
function outOfScope(pool: Pool, m: ModelName, d: unknown, cutoff: number): boolean {
  const x = d as {state?: string; status?: string; updated_at?: string; issue_id?: number; pull_id?: number};
  const old = unixSeconds(x.updated_at) < cutoff;
  if (m === 'Issue') return x.state === 'closed' && old;
  if (AGED.has(m)) return old;
  if (m === 'Notification') return x.status === 'read' && old;
  const closedIssue = (id: number | undefined) => {
    const i = id === undefined ? undefined : pool.model('Issue').get(id);
    return i?._d.state === 'closed' && unixSeconds(i._d.updated_at) < cutoff;
  };
  if (ISSUE_CHILDREN.has(m)) return closedIssue(x.issue_id);
  if (m === 'AutoMerge') return closedIssue(x.pull_id === undefined ? undefined : pool.model('PullRequest').get(x.pull_id)?._d.issue_id);
  return false;
}

function issueOf(e: Entity): number | undefined {
  return (e._d as {issue_id?: number}).issue_id;
}

function updatedUnix(e: Entity): number {
  return unixSeconds((e._d as {updated_at?: string}).updated_at);
}

function scopeOf(held: Entity[], input: ReplaceInput, models: Set<string> | undefined): (e: Entity) => boolean {
  const {header, end, received} = input;
  const modelOK = (e: Entity) => !models || models.has(e.model);
  if (header.tier === 'closed') {
    const cutoff = input.summaryClosedBefore;
    const before = parseCursor(header.before ?? '');
    const next = end.next ? parseCursor(end.next) : undefined;
    const pageIssues = new Set(received.get('Issue') ?? []);
    const ranged = new Set<number>();
    for (const e of held) {
      if (e.model !== 'Issue') continue;
      const d = e._d as {state: string};
      const u = updatedUnix(e);
      if (d.state !== 'closed' || Number.isNaN(u)) continue;
      if (cutoff !== undefined && !(u < cutoff)) continue;
      if (before && !below(u, e.id, before)) continue;
      if (next && below(u, e.id, next)) continue;
      ranged.add(e.id);
    }
    const issues = new Set([...ranged, ...pageIssues]);
    const pulls = pullsOf(held, issues);
    return (e) => {
      if (!modelOK(e)) return false;
      if (e.model === 'Issue') return ranged.has(e.id);
      if (ISSUE_CHILDREN.has(e.model)) return issues.has(issueOf(e) ?? 0);
      if (e.model === 'AutoMerge') return pulls.has((e._d as {pull_id: number}).pull_id);
      return false;
    };
  }
  const cutoff = header.closed_before;
  const unitsChanged = input.heldUnits !== undefined && !sameUnits(input.heldUnits, header.units);
  if (cutoff === undefined || unitsChanged) return modelOK;
  // The closed tier held: kept as the deltas left it.
  const closed = new Set<number>();
  for (const e of held) {
    if (e.model !== 'Issue') continue;
    if ((e._d as {state: string}).state === 'closed' && updatedUnix(e) < cutoff) closed.add(e.id);
  }
  const closedPulls = pullsOf(held, closed);
  return (e) => {
    if (!modelOK(e)) return false;
    if (e.model === 'Issue') return !closed.has(e.id);
    if (ISSUE_CHILDREN.has(e.model)) return !closed.has(issueOf(e) ?? 0);
    if (e.model === 'AutoMerge') return !closedPulls.has((e._d as {pull_id: number}).pull_id);
    if (AGED.has(e.model)) return !(updatedUnix(e) < cutoff);
    if (e.model === 'Notification') return !((e._d as {status: string}).status === 'read' && updatedUnix(e) < cutoff);
    return true;
  };
}

/** The ids of the PullRequests (held in the group) of these issues. */
function pullsOf(held: Entity[], issues: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const e of held) {
    if (e.model === 'PullRequest' && issues.has(issueOf(e) ?? 0)) out.add(e.id);
  }
  return out;
}
