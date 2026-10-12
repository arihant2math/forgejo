// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Apply locally, then persist the intent and frozen request before sending; storage failures use in-memory handoff.
// Only the caught-up leader sends, serially per entity; temporary references wait for remapping.
// Retries reuse the same key and request. Conflicts park; failures preserve user text as drafts.
// Keep overlays until sync confirms the write to avoid flicker.

import {observable, reaction, runInAction, untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import {
  HeaderIdempotencyKey, HeaderSyncID, RUMConflictDiscarded, RUMConflictMerged, RUMConflictOverride, RUMIntentFailed, RUMIntentFlushed,
  RUMIntentRetried, RUMMutationAcked, RUMMutationConfirmed, RUMMutationLocal,
} from '../protocol/types.gen.ts';
import {netSignal} from '../sync/net.ts';
import {count, queueDepth, sample} from '../sync/rum.ts';
import {effectHeld, lastChangedBy, scalarField, serverScalar} from './effects.ts';
import {chainOf, CREATES, describeIntent, groupOf, type Intent, type IntentInput, intentOps, intentText, isTemp, type Names, newIntent, POLICY, remapIntent, tempNum, tempRefs, uuid} from './intents.ts';
import {merge3} from './merge3.ts';
import type {Overlay} from './overlay.ts';
import {type ApiRequest, NotReady, requestFor, UnsendableIntent} from './rest.ts';
import {type Conflict, type DraftRecord, failedKey, type IntentDb, type IntentRecord} from './store.ts';

/** sending: cannot retract; kept: retry discard; unknown: leader vanished before answering. */
export type Discarded = 'discarded' | 'sending' | 'kept' | 'unknown';

/** Messages between the tabs of one user (a BroadcastChannel per user). */
export type IntentMessage =
  | {t: 'added'; rec: IntentRecord}
  | {t: 'changed'; rec: IntentRecord}
  | {t: 'done'; id: string; group?: string; v?: number}
  | {t: 'failed'; id: string; draft: DraftRecord}
  | {t: 'draft'; draft: DraftRecord}
  | {t: 'draftGone'; key: string}
  | {t: 'remap'; model: string; from: number; to: number; number?: number}
  | {t: 'override'; override: Override}
  | {t: 'discard'; id: string}
  | {t: 'discarded'; id: string; ok: boolean}
  /** Re-read on takeover: the departing leader’s final broadcasts may be lost. */
  | {t: 'leader'}
  | {t: 'overrideGone'; id: string};

export interface Channel {
  post(m: IntentMessage): void;
  onMessage(fn: (m: IntentMessage) => void): () => void;
  close(): void;
}

/** "You overrode @alice's change": a scalar the user set over someone else's newer value. */
export interface Override {
  id: string;
  issueId: number;
  repoId: number;
  field: string;
  /** Who made the change that was overridden (0: unknown). */
  who: number;
  /** The overridden value, used by undo. */
  theirs: unknown;
  mine: unknown;
  /** The intent that undoes it. */
  undo: IntentInput;
  /** Change time in milliseconds since epoch. */
  since?: number;
}

export interface IntentEnv {
  pool: Pool;
  overlay: Overlay;
  userId: number;
  db: IntentDb;
  channel: Channel;
  /** Observable: this tab leads (flushes). */
  isLeader(): boolean;
  /** Observable: the sync connection (SyncStatus.connection). */
  connection(): string;
  onCaughtUp(fn: () => void): () => void;
  onRevoked(fn: (group: string) => void): () => void;
  /** Deleted or moved out of reach. */
  onIssueDropped?(fn: (issueId: number) => void): () => void;
  whenSynced(group: string, v: number, signal?: AbortSignal): Promise<void>;
  /** Data.barrier: raises every subscribed group's position to the server's (when an echo is slow to be reached). */
  barrier?(): Promise<unknown>;
  /** A current access token; rejects when signed out. */
  token(): Promise<string>;
  /** The server refused the token: a new one, or null (signed out). */
  refresh(): Promise<string | null>;
  /** API v1's base URL ("/api/v1" below the instance's sub-path). */
  apiBase: string;
  /** livesync's gap endpoints ("/-/sync/api" below the sub-path). */
  syncApiBase: string;
  online(): boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a confirmation may take before the layer is dropped anyway (ms, default 60 s). */
  confirmTimeout?: number;
  /** How long to wait for the echo before asking for a barrier (ms, default 3 s). */
  barrierAfter?: number;
  /** Base and cap of the retry backoff (ms, default 1 s and 5 min). */
  backoff?: number;
  maxBackoff?: number;
  names?: () => Names;
  onFailed?(d: DraftRecord): void;
  onOverride?(o: Override): void;
  onConflict?(rec: IntentRecord): void;
  onRemap?(r: {model: string; from: number; to: number; number?: number}): void;
}

/** Requests in flight at once, across entities. */
const MAX_SENDS = 6;

/** Hot-row echoes are deferred; dependencies arrive on the issue’s next load. */
const HOT_KINDS: ReadonlySet<string> = new Set(['notification.status', 'notification.readAll', 'issue.dependency']);
const HOT_WAIT_MS = 5000;

/** RUM: an intent first attempted within this long of its local apply was sent at once (online). */
const IMMEDIATE_MS = 1000;

/** Queued and parked intents can be discarded even if a request was attempted. */
export function discardable(rec: IntentRecord): boolean {
  // An attempted request may already have reached Forgejo; its result can still sync back after discard.
  return rec.state === 'parked' || rec.state === 'queued';
}

export class Intents {
  private readonly env: IntentEnv;
  readonly records = observable.map<string, IntentRecord>({}, {deep: false});
  readonly drafts = observable.map<string, DraftRecord>({}, {deep: false});
  /** Temporary ids replaced by the server's (Comment/Issue/Review), for views that list created entities. */
  readonly remapped = observable.map<number, number>({}, {deep: false});
  readonly overrides = observable.array<Override>([], {deep: false});
  private readonly perIssue = observable.map<number, number>({}, {deep: false});
  /** Parked conflicts by text target (`body:<issue>`, `comment:<id>`) → record id (the editors observe one key). */
  private readonly parked = observable.map<string, string>({}, {deep: false});
  /** Sample only immediate sends, excluding offline, backoff, and parked time; remove after confirmation. */
  private readonly immediate = new Set<string>();
  private readonly discards = new Map<string, (ok: boolean) => void>();
  /** Being discarded by this (leader) tab: not sent meanwhile. */
  private readonly discarding = new Set<string>();
  /** Intents whose storing failed: kept in memory (a re-read must not drop them). */
  private readonly memoryOnly = new Set<string>();
  /** Resolves once the stored queue is in the overlay. */
  readonly ready: Promise<void>;

  /** Submitted here and not stored yet (a re-read must not drop them). */
  private readonly unstored = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly confirming = new Set<string>();
  private readonly nextAt = new Map<string, number>();
  private wake: ReturnType<typeof setTimeout> | undefined;
  private pumpQueued = false;
  private orphanCheck = false;
  /** Until this chain empties, bypass pool shortcuts after an unconfirmed write. */
  private readonly stale = new Set<string>();
  /** Hold the queue while signed out. */
  private held = false;
  private barrierPending: Promise<unknown> | undefined;
  private barrierAgain = false;
  private closed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(env: IntentEnv) {
    this.env = env;
    this.cleanups.push(env.channel.onMessage((m) => {
      this.onMessage(m);
    }));
    this.ready = this.reread();
    this.cleanups.push(env.onCaughtUp(() => {
      this.kick();
    }));
    // A parked conflict may have lost its target (a comment deleted on the server): the pump checks.
    this.cleanups.push(env.pool.onApplied(() => {
      if (this.parked.size && this.env.isLeader()) this.kick();
    }));
    this.cleanups.push(env.onRevoked((group) => {
      if (this.env.isLeader()) void this.revoked(group);
    }));
    if (env.onIssueDropped) {
      this.cleanups.push(env.onIssueDropped((issueId) => {
        if (this.env.isLeader()) void this.dropped(`issue:${String(issueId)}`, 'The issue is not there any more, or you cannot see it.');
      }));
    }
    this.cleanups.push(reaction(() => [env.isLeader(), env.connection()] as const, ([leader, connection], prev) => {
      if (connection === 'live') this.held = false;
      if (leader && !prev[0]) this.takeOver();
      else this.kick();
    }, {fireImmediately: false}));
    if (env.isLeader()) this.takeOver();
  }

  /** Applies an intent to the overlay at once, stores it (a fresh Idempotency-Key) and queues it; returns it. */
  submit(input: IntentInput, replaces: {draft?: string; intent?: string} = {}): Intent {
    const t0 = performance.now();
    const i = this.remapKnown(newIntent(input, this.now()));
    const names = this.env.names?.() ?? {};
    const issueNumber = issueNumberOf(i, names);
    const rec: IntentRecord = {
      id: i.id, intent: i, state: 'queued', attempts: 0, updated: this.now(), title: describeIntent(i, names),
      ...(issueNumber === undefined ? {} : {issueNumber}),
    };
    this.unstored.add(i.id);
    this.apply(() => {
      if (replaces.intent) {
        const seq = this.records.get(replaces.intent)?.seq;
        if (seq !== undefined) rec.seq = seq;
        this.forget(replaces.intent);
      }
      if (replaces.draft) this.drafts.delete(replaces.draft);
      this.track(rec);
    });
    queueDepth(this.records.size);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      sample(RUMMutationLocal, performance.now() - t0);
    });
    void this.env.db.add(rec, replaces).then((stored) => {
      this.unstored.delete(i.id);
      if (this.closed) return;
      this.apply(() => {
        const cur = this.records.get(i.id);
        if (cur && stored.seq !== undefined) this.records.set(i.id, {...cur, seq: stored.seq});
      });
      this.env.channel.post({t: 'added', rec: stored});
      if (replaces.draft) this.env.channel.post({t: 'draftGone', key: replaces.draft});
      if (replaces.intent) this.env.channel.post({t: 'done', id: replaces.intent});
      this.kick();
    }, (err: unknown) => {
      // Preserve unstored intents across re-reads and report the storage failure.
      this.unstored.delete(i.id);
      this.memoryOnly.add(i.id);
      // Storage failed, so hand this intent to the leader in memory.
      this.env.channel.post({t: 'added', rec});
      console.error('intents: storing failed', err);
      this.apply(() => {
        const r = this.records.get(i.id);
        if (r) this.records.set(i.id, {...r, note: 'Not saved on this device: keep this tab open until it syncs.'});
      });
      this.kick();
    });
    return i;
  }

  /** Intents not confirmed yet (queued, sending, waiting for their echo, parked). */
  get pending(): number {
    return this.records.size;
  }

  get failedCount(): number {
    let n = 0;
    for (const d of this.drafts.values()) if (d.kind === 'failed') n++;
    return n;
  }

  /** The UUID of an unsynced locally created issue, used by its route. */
  tempIdOf(issueId: number): string | undefined {
    for (const rec of this.records.values()) {
      const i = rec.intent;
      if (i.kind === 'issue.create' && i.issueId === issueId) return i.tempId;
    }
    return undefined;
  }

  /** Observable: the number of intents pending on an issue (its pending badge). */
  pendingOn(issueId: number): number {
    return this.perIssue.get(issueId) ?? 0;
  }

  /** Observes only this text target’s parked conflict. */
  conflictOf(kind: 'issue.body' | 'comment.edit', id: number): IntentRecord | undefined {
    const rec = this.parked.get(kind === 'issue.body' ? `body:${String(id)}` : `comment:${String(id)}`);
    return rec === undefined ? undefined : untracked(() => this.records.get(rec));
  }

  /** Atomically replaces the conflict with a new key based on the server’s text and version. */
  resolve(id: string, text: string): Intent | undefined {
    const rec = this.records.get(id);
    const c = rec?.conflict;
    if (!rec || !c) return undefined;
    const i = rec.intent;
    if (i.kind === 'issue.body') return this.submit({issueId: i.issueId, repoId: i.repoId, kind: 'issue.body', text, baseText: c.theirs, baseVersion: c.version}, {intent: id});
    if (i.kind === 'comment.edit') {
      return this.submit({issueId: i.issueId, repoId: i.repoId, commentId: i.commentId, kind: 'comment.edit', text, baseText: c.theirs, baseVersion: c.version, baseUpdated: c.updated !== undefined && c.updated !== '' ? c.updated : i.baseUpdated}, {intent: id});
    }
    return undefined;
  }

  /** Retries a failed intent from its draft: the same change as a new intent (a new key). */
  retry(draftKey: string): Intent | undefined {
    const d = this.drafts.get(draftKey);
    if (!d?.intent) return undefined;
    return this.submit(strip(d.intent), {draft: draftKey});
  }

  /** The same change again, as a new intent (an undone discard). */
  resubmit(i: Intent): Intent {
    return this.submit(strip(i));
  }

  async discardDraft(key: string): Promise<void> {
    await this.env.db.deleteDraft(key);
    this.apply(() => this.drafts.delete(key));
    this.env.channel.post({t: 'draftGone', key});
  }

  async restoreDraft(d: DraftRecord): Promise<void> {
    await this.env.db.putDraft(d);
    this.apply(() => this.drafts.set(d.key, d));
    this.env.channel.post({t: 'draft', draft: d});
  }

  async keepText(d: Omit<DraftRecord, 'kind' | 'at'>): Promise<void> {
    const draft: DraftRecord = {...d, kind: 'text', at: this.now()};
    await this.env.db.putDraft(draft);
    this.apply(() => this.drafts.set(draft.key, draft));
    this.env.channel.post({t: 'draft', draft});
  }

  /** The leader retracts queued or parked intents because only it knows what is in flight. */
  discard(id: string, again = true): Promise<Discarded> {
    if (!this.env.isLeader()) {
      // If the leader does not answer, re-read the durable queue to determine the outcome.
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.discards.delete(id);
          void this.reread().then(() => {
            resolve(this.records.has(id) ? 'kept' : 'unknown');
          });
        }, 3000);
        this.discards.set(id, (ok) => {
          clearTimeout(timer);
          resolve(ok ? 'discarded' : 'sending');
        });
        this.env.channel.post({t: 'discard', id});
      });
    }
    const rec = this.records.get(id);
    if (!rec && again) return this.reread().then(() => this.discard(id, false));
    if (!rec || this.sending.has(id) || this.discarding.has(id) || !discardable(rec)) return Promise.resolve(rec ? 'sending' : 'unknown');
    // Not sent while it is removed (a kick in between would start it).
    this.discarding.add(id);
    return this.env.db.remove(id).then(() => {
      if (rec.state === 'parked') count(RUMConflictDiscarded);
      this.finishLocal(id);
      this.env.channel.post({t: 'done', id});
      return 'discarded' as const;
    }, () => 'kept' as const).finally(() => {
      this.discarding.delete(id);
      this.kick();
    });
  }

  undoOverride(id: string): void {
    const o = this.overrides.find((x) => x.id === id);
    if (!o) return;
    this.dismissOverride(id);
    this.submit(o.undo);
  }

  dismissOverride(id: string, tell = true): void {
    this.apply(() => {
      const k = this.overrides.findIndex((x) => x.id === id);
      if (k >= 0) this.overrides.splice(k, 1);
    });
    // Every tab drops it (an undo is offered once).
    if (tell) this.env.channel.post({t: 'overrideGone', id});
  }

  private takeOver(): void {
    void this.ready.then(() => this.reread()).then(() => {
      this.env.channel.post({t: 'leader'});
      this.kick();
    }, (err: unknown) => {
      console.error('intents: reading the queue failed', err);
    });
  }

  async reread(): Promise<void> {
    const [recs, drafts, remaps] = await Promise.all([this.env.db.list(), this.env.db.drafts(), this.env.db.remaps()]);
    if (this.closed) return;
    this.apply(() => {
      for (const [from, to] of remaps) if (this.remapped.get(from) !== to) this.remapped.set(from, to);
      const seen = new Set<string>();
      for (const r of recs) {
        seen.add(r.id);
        const cur = this.records.get(r.id);
        if (!cur) this.track(r);
        // In flight here: this tab's state is newer than a read taken before its last write.
        else if (!this.sending.has(r.id) && !this.confirming.has(r.id)) this.replace(r);
      }
      for (const id of [...this.records.keys()]) {
        if (!seen.has(id) && !this.unstored.has(id) && !this.memoryOnly.has(id) && !this.sending.has(id) && !this.confirming.has(id)) this.forget(id);
      }
      const keys = new Set(drafts.map((d) => d.key));
      for (const k of [...this.drafts.keys()]) if (!keys.has(k)) this.drafts.delete(k);
      for (const d of drafts) if (JSON.stringify(this.drafts.get(d.key)) !== JSON.stringify(d)) this.drafts.set(d.key, d);
    });
  }

  close(): void {
    this.closed = true;
    if (this.wake) clearTimeout(this.wake);
    for (const c of this.cleanups) c();
  }

  private apply(fn: () => void): void {
    runInAction(fn);
  }

  private track(rec: IntentRecord): void {
    this.records.set(rec.id, rec);
    this.env.overlay.add(rec.id, intentOps(rec.intent, {userId: this.env.userId}));
    const issue = rec.intent.issueId;
    if (issue) this.perIssue.set(issue, (this.perIssue.get(issue) ?? 0) + 1);
    this.noteParked(undefined, rec);
  }

  private replace(rec: IntentRecord): void {
    const cur = this.records.get(rec.id);
    if (!cur || JSON.stringify(cur) === JSON.stringify(rec)) return;
    if (cur.intent.issueId !== rec.intent.issueId) {
      this.count(cur.intent.issueId, -1);
      this.count(rec.intent.issueId, 1);
    }
    this.records.set(rec.id, rec);
    if (JSON.stringify(cur.intent) !== JSON.stringify(rec.intent)) this.env.overlay.add(rec.id, intentOps(rec.intent, {userId: this.env.userId}));
    this.noteParked(cur, rec);
  }

  private forget(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    const chain = chainOf(rec.intent);
    if (this.stale.has(chain) && ![...this.records.values()].some((r) => chainOf(r.intent) === chain)) this.stale.delete(chain);
    this.env.overlay.remove(id);
    this.count(rec.intent.issueId, -1);
    this.nextAt.delete(id);
    this.memoryOnly.delete(id);
    this.noteParked(rec, undefined);
  }

  private noteParked(before: IntentRecord | undefined, after: IntentRecord | undefined): void {
    const was = before?.state === 'parked' ? textTarget(before.intent) : undefined;
    const now = after?.state === 'parked' ? textTarget(after.intent) : undefined;
    if (was !== undefined && was !== now && this.parked.get(was) === before?.id) this.parked.delete(was);
    if (now !== undefined && after && this.parked.get(now) !== after.id) this.parked.set(now, after.id);
  }

  private remapKnown(i: Intent): Intent {
    let out = i;
    for (const t of tempRefs(i)) {
      const to = untracked(() => this.remapped.get(t));
      if (to !== undefined) out = remapIntent(out, t, to);
    }
    return out;
  }

  private count(issue: number, by: number): void {
    if (!issue) return;
    const n = (this.perIssue.get(issue) ?? 0) + by;
    if (n > 0) this.perIssue.set(issue, n);
    else this.perIssue.delete(issue);
  }

  private finishLocal(id: string): void {
    this.apply(() => {
      this.forget(id);
    });
  }

  private onMessage(m: IntentMessage): void {
    if (this.closed) return;
    switch (m.t) {
      case 'added':
        this.apply(() => {
          if (!this.records.has(m.rec.id)) this.track(m.rec);
        });
        // Not stored (its tab's storage failed): kept in memory here too (a re-read must not drop it).
        if (m.rec.seq === undefined) this.memoryOnly.add(m.rec.id);
        this.kick();
        break;
      case 'changed':
        this.apply(() => {
          this.replace(m.rec);
        });
        if (m.rec.state === 'parked' && this.visible()) this.env.onConflict?.(m.rec);
        break;
      case 'done':
        // The leader's pool holds the write; this tab's once it mirrored that state (no flicker).
        if (m.group !== undefined && m.v !== undefined && this.env.pool.groupEntities(m.group).size > 0) {
          void this.env.whenSynced(m.group, m.v, AbortSignal.timeout(this.env.confirmTimeout ?? 60_000))
            .catch(() => undefined)
            .then(() => {
              this.finishLocal(m.id);
            });
        } else {
          this.finishLocal(m.id);
        }
        break;
      case 'failed':
        this.apply(() => {
          this.forget(m.id);
          this.drafts.set(m.draft.key, m.draft);
        });
        if (this.visible()) this.env.onFailed?.(m.draft);
        break;
      case 'draft':
        this.apply(() => this.drafts.set(m.draft.key, m.draft));
        break;
      case 'draftGone':
        this.apply(() => this.drafts.delete(m.key));
        break;
      case 'remap':
        this.apply(() => this.remapped.set(m.from, m.to));
        this.env.onRemap?.(m);
        break;
      case 'override':
        this.apply(() => this.overrides.push(m.override));
        if (this.visible()) this.env.onOverride?.(m.override);
        break;
      case 'discard':
        if (this.env.isLeader()) {
          void this.discard(m.id).then((r) => {
            this.env.channel.post({t: 'discarded', id: m.id, ok: r === 'discarded'});
          });
        }
        break;
      case 'discarded':
        this.discards.get(m.id)?.(m.ok);
        this.discards.delete(m.id);
        break;
      case 'leader':
        if (!this.env.isLeader()) void this.reread();
        break;
      case 'overrideGone':
        this.dismissOverride(m.id, false);
        break;
    }
  }

  private visible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  private now(): number {
    return (this.env.now ?? Date.now)();
  }

  /** Send only while signed in and caught up, so requests use a current base state. */
  private get open(): boolean {
    return !this.closed && !this.held && this.env.isLeader() && this.env.connection() === 'live' && this.env.online();
  }

  kick(): void {
    if (this.pumpQueued || this.closed) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (!this.env.isLeader()) return;
    // Confirm acknowledged writes even while sending is blocked or after leader takeover.
    for (const rec of this.records.values()) if (rec.state === 'acked' && !this.confirming.has(rec.id)) void this.confirm(rec);
    if (!this.open) return;
    const now = this.now();
    const blocked = new Set<string>();
    let soonest = Number.POSITIVE_INFINITY;
    const order = [...this.records.values()].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) || a.intent.created - b.intent.created);
    // Parked conflicts block later edits of the same text, not other issue changes.
    const parkedTargets = new Map<string, IntentRecord>();
    const waiting: IntentRecord[] = [];
    for (const rec of order) {
      const i = rec.intent;
      const chain = chainOf(i);
      const target = textTarget(i);
      if (rec.state === 'parked') {
        if (target) parkedTargets.set(target, rec);
        if (i.kind === 'comment.edit' && this.env.pool.groupEntities(`issue:${String(i.issueId)}`).size > 0 && !untracked(() => this.env.pool.model('Comment').get(i.commentId))) {
          void this.fail(rec, 'The comment was deleted.', true);
        }
        continue;
      }
      if (blocked.has(chain)) continue;
      const parkedHere = target === undefined ? undefined : parkedTargets.get(target);
      if (parkedHere) {
        if (i.kind === 'comment.delete') void this.fail(parkedHere, 'You deleted this comment; your edit is kept here.');
        continue;
      }
      // Wait for temporary-id remaps without blocking unrelated issue changes.
      if (tempRefs(i).length) {
        const remapped = this.remapKnown(i);
        if (remapped !== i) {
          blocked.add(chain);
          void this.save([{...rec, intent: remapped, updated: this.now()}]).then(() => {
            this.kick();
          });
        } else waiting.push(rec);
        continue;
      }
      blocked.add(chain);
      // Acked: the entity's next intent waits for its echo (it is prepared against the state that includes it).
      if (rec.state === 'acked' || this.sending.has(rec.id) || this.discarding.has(rec.id) || this.unstored.has(rec.id) || this.sending.size >= MAX_SENDS) continue;
      const at = this.nextAt.get(rec.id) ?? 0;
      if (at > now) {
        soonest = Math.min(soonest, at);
        continue;
      }
      void this.send(rec);
    }
    if (waiting.length) void this.orphans(waiting);
    if (this.wake) clearTimeout(this.wake);
    this.wake = undefined;
    if (soonest < Number.POSITIVE_INFINITY) {
      this.wake = setTimeout(() => {
        this.wake = undefined;
        this.kick();
      }, Math.max(0, soonest - now));
    }
  }

  /** Re-read before sending so unannounced earlier intents in the same chain still go first. */
  private async unknownBefore(rec: IntentRecord): Promise<boolean> {
    const stored = await this.env.db.list();
    if (this.closed) return true;
    if (rec.seq !== undefined && !stored.some((r) => r.id === rec.id)) {
      this.finishLocal(rec.id);
      return true;
    }
    const unknown = stored.filter((r) => !this.records.has(r.id));
    if (unknown.length) {
      this.apply(() => {
        for (const r of unknown) this.track(r);
      });
    }
    const parkedTargets = new Set(stored.filter((r) => r.state === 'parked').map((r) => textTarget(r.intent)).filter((t) => t !== undefined));
    return stored.some((r) => r.id !== rec.id && (r.seq ?? 0) < (rec.seq ?? Number.MAX_SAFE_INTEGER) && holdsBack(r, rec, (t) => this.remapped.has(t), parkedTargets));
  }

  /** Fail orphaned temporary references, checking IndexedDB for creates held by other tabs. */
  private async orphans(waiting: IntentRecord[]): Promise<void> {
    if (this.orphanCheck) return;
    this.orphanCheck = true;
    try {
      const stored = await this.env.db.list();
      const creating = new Set<number>();
      for (const r of [...stored, ...this.records.values()]) {
        const i = r.intent;
        if (i.kind === 'issue.create') creating.add(i.issueId);
        else if ('tempId' in i) creating.add(tempNum(i.tempId));
      }
      for (const r of waiting) {
        if (!this.records.has(r.id)) continue;
        if (tempRefs(r.intent).some((t) => !creating.has(t) && !this.remapped.has(t))) await this.fail(r, 'It depends on a change that was discarded or could not be made.');
      }
    } finally {
      this.orphanCheck = false;
    }
  }

  /** Updates existing records only; returns which survived concurrent completion. */
  private async save(recs: IntentRecord[], remap?: [number, number]): Promise<boolean[]> {
    const stored = recs.filter((r) => r.seq !== undefined);
    const ok = stored.length ? await this.env.db.update(stored, remap) : [];
    let k = 0;
    const out = recs.map((r) => (r.seq === undefined ? this.records.has(r.id) : ok[k++] ?? false));
    if (this.closed) return out.map(() => false);
    this.apply(() => {
      recs.forEach((r, n) => {
        if (out[n]) this.replace(r);
      });
    });
    recs.forEach((r, n) => {
      if (out[n]) this.env.channel.post({t: 'changed', rec: r});
    });
    return out;
  }

  private later(rec: IntentRecord, ms: number, note: string | undefined, attempt: boolean): Promise<unknown> {
    this.immediate.delete(rec.id);
    const attempts = attempt ? rec.attempts + 1 : rec.attempts;
    if (attempt) count(RUMIntentRetried);
    const wait = ms >= 0 ? ms : Math.min(this.env.maxBackoff ?? 300_000, (this.env.backoff ?? 1000) * 2 ** Math.max(0, attempts - 1));
    this.nextAt.set(rec.id, this.now() + wait);
    if (attempts === rec.attempts && note === rec.note) return Promise.resolve();
    return this.save([{...rec, attempts, ...(note === undefined ? {} : {note}), updated: this.now()}]);
  }

  private async send(rec0: IntentRecord): Promise<void> {
    const {env} = this;
    let rec = rec0;
    this.sending.add(rec.id);
    try {
      if (await this.unknownBefore(rec)) return;
      const i = rec.intent;
      if (rec.req === undefined && POLICY[i.kind] !== 'create' && !this.stale.has(chainOf(i)) && effectHeld(env.pool, i, env.userId)) {
        await this.done(rec, undefined);
        return;
      }
      if (rec.req === undefined) {
        const prepared = await this.prepare(rec);
        if (!prepared) return;
        rec = prepared;
      }
      const req = rec.req;
      if (!req) return;
      await this.attempt(rec, req);
    } catch (err) {
      if (this.closed) return;
      if (err instanceof NotReady) await this.later(rec, -1, `Waiting: ${err.message}.`, false);
      else if (err instanceof UnsendableIntent) await this.fail(rec, `It cannot be sent: ${err.message}.`);
      else {
        console.error('intents: sending failed', err);
        await this.later(rec, -1, String(err), true);
      }
    } finally {
      this.sending.delete(rec.id);
      this.kick();
    }
  }

  /** Rebase and freeze the request with its key; undefined means parked or gone. */
  private async prepare(rec0: IntentRecord): Promise<IntentRecord | undefined> {
    const {env} = this;
    let rec = rec0;
    let i = rec.intent;
    // A stale entity (see `stale`): the server's 409 tells the current text instead of the pool.
    const fresh = !this.stale.has(chainOf(i));
    if (i.kind === 'issue.body' && fresh) {
      const srv = env.pool.model('IssueBody').get(i.issueId)?.data;
      if (srv && srv.body !== i.baseText) return this.rebase(rec, srv.body, srv.content_version);
      if (srv && srv.content_version !== i.baseVersion) i = {...i, baseVersion: srv.content_version};
    } else if (i.kind === 'comment.edit' && fresh) {
      const srv = env.pool.model('Comment').get(i.commentId)?.data;
      if (srv && srv.updated_at !== i.baseUpdated && srv.body !== i.baseText) {
        await this.park(rec, {theirs: srv.body, version: srv.content_version, updated: srv.updated_at, merged: merge3(i.baseText, srv.body, i.text).text});
        return undefined;
      }
      if (srv && srv.content_version !== i.baseVersion) i = {...i, baseVersion: srv.content_version};
    }
    const req = requestFor(i, env.pool, env.overlay);
    rec = {...rec, intent: i, req, updated: this.now()};
    // Earlier intents are confirmed, so base comparisons use the state the user saw.
    if (POLICY[i.kind] === 'scalar' && 'base' in i && fresh) {
      const cur = serverScalar(env.pool, i);
      const mine = valueOf(i);
      if (cur !== undefined && cur !== i.base && cur !== mine) rec = {...rec, override: {theirs: cur, who: lastChangedBy(env.pool, i) ?? 0}};
    }
    const [ok] = await this.save([rec]);
    return ok ? rec : undefined;
  }

  /** A text edit whose base moved: 3-way merge; clean ⇒ the merge under a new key, else parked. */
  private async rebase(rec: IntentRecord, theirs: string, version: number): Promise<IntentRecord | undefined> {
    const i = rec.intent;
    if (i.kind !== 'issue.body') return undefined;
    const m = merge3(i.baseText, theirs, i.text);
    if (!m.clean) {
      await this.park(rec, {theirs, version, merged: m.text});
      return undefined;
    }
    const merged: Intent = {...i, baseText: theirs, baseVersion: version, text: m.text, key: uuid()};
    count(RUMConflictMerged);
    if (merged.text === theirs && !this.stale.has(chainOf(i))) {
      await this.done({...rec, intent: merged}, undefined);
      return undefined;
    }
    const next: IntentRecord = {...rec, intent: merged, attempts: 0, req: requestFor(merged, this.env.pool, this.env.overlay), updated: this.now()};
    delete next.note;
    const [ok] = await this.save([next]);
    return ok ? next : undefined;
  }

  private async park(rec: IntentRecord, conflict: Conflict): Promise<void> {
    this.immediate.delete(rec.id);
    const next: IntentRecord = {...rec, state: 'parked', conflict, updated: this.now()};
    delete next.req;
    const [ok] = await this.save([next]);
    if (ok && this.visible()) this.env.onConflict?.(next);
  }

  private async attempt(rec: IntentRecord, req: ApiRequest): Promise<void> {
    const {env} = this;
    if (rec.attempts === 0 && this.now() - rec.intent.created < IMMEDIATE_MS) {
      if (this.immediate.size > 1000) this.immediate.clear();
      this.immediate.add(rec.id);
    }
    let token: string;
    try {
      token = await env.token();
    } catch (err) {
      // Signed-out sessions hold the queue; unreachable token endpoints retry later.
      this.immediate.delete(rec.id);
      if (err instanceof Error && err.name === 'SignedOut') this.held = true;
      else await this.later(rec, -1, 'Could not get a session token; retrying.', false);
      return;
    }
    const res = await this.fetch(rec, req, token);
    if (!res) {
      this.immediate.delete(rec.id); // offline mid-flight, or retrying
      return;
    }
    if (res.status === 401) {
      this.immediate.delete(rec.id); // a refresh, maybe a hold
      // null: signed out (held); a throw: the token endpoint unreachable (try again later).
      const t = await env.refresh().then((x) => x, () => undefined);
      if (t === undefined) {
        await this.later(rec, -1, 'Could not refresh the session; retrying.', false);
        return;
      }
      if (t === null) {
        this.held = true;
        return;
      }
      const again = await this.fetch(rec, req, t);
      if (!again) return;
      if (again.status === 401) {
        this.held = true;
        return;
      }
      await this.answer(rec, again);
      return;
    }
    await this.answer(rec, res);
  }

  /** One request; undefined when it got no answer (retried later, the same key). */
  private async fetch(rec: IntentRecord, req: ApiRequest, token: string): Promise<Response | undefined> {
    const {env} = this;
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    try {
      const res = await (env.fetch ?? fetch)(`${req.api === 'v1' ? env.apiBase : env.syncApiBase}${req.path}`, {
        method: req.method,
        headers: {
          'Authorization': `Bearer ${token}`,
          [HeaderIdempotencyKey]: rec.intent.key,
          'Accept': 'application/json',
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        ...(body === undefined ? {} : {body}),
        credentials: 'omit',
        // The API answers writes directly: never follow a redirect with the token.
        redirect: 'manual',
        signal: netSignal(30_000),
      });
      if (this.closed) return undefined;
      return res;
    } catch {
      if (this.closed) return undefined;
      // The same key makes the retry safe whether or not the attempt reached the server.
      if (!env.online()) {
        this.nextAt.delete(rec.id);
        return undefined;
      }
      await this.later(rec, -1, 'Forgejo could not be reached; retrying.', true);
      return undefined;
    }
  }

  private async answer(rec: IntentRecord, res: Response): Promise<void> {
    const i = rec.intent;
    if (res.type === 'opaqueredirect') {
      await this.fail(rec, 'Forgejo answered with a redirect.');
      return;
    }
    if (res.ok) {
      // Forgejo returns 200 without the label when adding a nonexistent label.
      if (i.kind === 'issue.label' && i.add && !await hasLabel(res, i.labelId)) {
        await this.fail(rec, 'The label no longer exists on Forgejo.', true);
        return;
      }
      await this.ack(rec, res);
      return;
    }
    const after = Number(res.headers.get('Retry-After') ?? Number.NaN);
    // Retry-After in seconds (≤ 60); "0" means at once (the base backoff).
    const wait = Number.isFinite(after) && after >= 0 ? Math.max(Math.min(after, 60) * 1000, this.env.backoff ?? 1000) : -1;
    if (res.status === 409) {
      const j = await json(res);
      // Use the server’s conflict text and version as the next base.
      if ((i.kind === 'issue.body' || i.kind === 'comment.edit') && typeof j?.content_version === 'number' && typeof j.body === 'string') {
        if (i.kind === 'issue.body') {
          const next = await this.rebase(rec, j.body, j.content_version);
          if (next?.req) await this.attempt(next, next.req);
        } else if (j.body === i.baseText) {
          // Only its version moved (the text is still the base): the same edit at the current version, under a new key.
          const next: IntentRecord = {...rec, intent: {...i, baseVersion: j.content_version, key: uuid()}, attempts: 0, updated: this.now()};
          delete next.req;
          await this.save([next]);
        } else {
          await this.park(rec, {theirs: j.body, version: j.content_version, updated: '', merged: merge3(i.baseText, j.body, i.text).text});
        }
        return;
      }
      // An earlier attempt with this key is still running; wait without spending attempts.
      if (res.headers.has('Retry-After')) {
        await this.later(rec, wait > 0 ? wait : this.env.backoff ?? 1000, undefined, false);
        return;
      }
      if (effectHeld(this.env.pool, i, this.env.userId)) await this.done(rec, undefined);
      else await this.fail(rec, message(j, res.status, i), true);
      return;
    }
    if (res.status === 404 && removes(i)) {
      await this.done(rec, undefined);
      return;
    }
    if (res.status === 429 || res.status >= 500) {
      const j = await json(res);
      const said = typeof j?.message === 'string' ? j.message.trim().slice(0, 300) : '';
      // Some API refusals return 500. Fail known refusals or identical messages on the third attempt.
      const note = `Forgejo answered ${String(res.status)}${said ? `: ${said}` : ''}; retrying.`;
      if (res.status === 500 && said && (refusal(said) || (rec.attempts >= 2 && rec.note === note))) {
        await this.fail(rec, message(j, res.status, i), true);
        return;
      }
      await this.later(rec, wait, note, true);
      return;
    }
    await this.fail(rec, message(await json(res), res.status, i), res.status !== 408);
  }

  private async ack(rec: IntentRecord, res: Response): Promise<void> {
    const v = Number(res.headers.get(HeaderSyncID));
    const i = rec.intent;
    const created = await createdId(i, res);
    const acked: IntentRecord = {...rec, state: 'acked', attempts: 0, ack: {...(Number.isSafeInteger(v) && v > 0 ? {v} : {}), ...(created ? {created} : {})}, updated: this.now()};
    delete acked.note;
    const changes: IntentRecord[] = [acked];
    let from: number | undefined;
    if (created && 'tempId' in i) {
      from = i.kind === 'issue.create' ? i.issueId : tempNum(i.tempId);
      for (const r of this.records.values()) {
        if (r.id === rec.id) continue;
        const ri = remapIntent(r.intent, from, created.id);
        if (ri !== r.intent) changes.push({...r, intent: ri, updated: this.now()});
      }
    }
    // Persist the remap with the ack so later intents and reloads resolve the temporary id.
    const ok = await this.save(changes, from !== undefined && created ? [from, created.id] : undefined);
    if (!ok[0]) return;
    count(RUMIntentFlushed);
    if (this.immediate.has(rec.id)) sample(RUMMutationAcked, this.now() - i.created);
    if (from !== undefined && created && 'tempId' in i) {
      const m = {t: 'remap' as const, model: CREATES[i.kind], from, to: created.id, ...(created.number ? {number: created.number} : {})};
      this.apply(() => this.remapped.set(m.from, m.to));
      this.env.channel.post(m);
      this.env.onRemap?.(m);
    }
    if (rec.override) this.override(acked, rec.override.theirs, rec.override.who);
    void this.confirm(acked);
  }

  private override(rec: IntentRecord, theirs: unknown, who: number): void {
    const i = rec.intent;
    const field = scalarField(i);
    if (!field || !('base' in i)) return;
    const mine = valueOf(i);
    let undo: IntentInput | undefined;
    const ref = {issueId: i.issueId, repoId: i.repoId};
    if (i.kind === 'issue.state') undo = {...ref, kind: 'issue.state', state: theirs as 'open' | 'closed', base: i.state};
    else if (i.kind === 'issue.title') undo = {...ref, kind: 'issue.title', title: theirs as string, base: i.title};
    else if (i.kind === 'issue.milestone') undo = {...ref, kind: 'issue.milestone', milestoneId: theirs as number, base: i.milestoneId};
    else if (i.kind === 'issue.deadline') undo = {...ref, kind: 'issue.deadline', due: theirs as string | null, base: i.due};
    if (!undo) return;
    const o: Override = {id: rec.id, issueId: i.issueId, repoId: i.repoId, field, who, theirs, mine, undo, since: i.created};
    count(RUMConflictOverride);
    this.apply(() => this.overrides.push(o));
    this.env.channel.post({t: 'override', override: o});
    if (this.visible()) this.env.onOverride?.(o);
  }

  /** Drop the layer after sync/effect confirmation, or after confirmTimeout if no echo arrives. */
  private async confirm(rec: IntentRecord): Promise<void> {
    if (this.confirming.has(rec.id)) return;
    this.confirming.add(rec.id);
    const {env} = this;
    const i = rec.intent;
    const v = rec.ack?.v;
    const group = groupOf(i, env.userId);
    const ctrl = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let off: (() => void) | undefined;
    const timeout = new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, env.confirmTimeout ?? 60_000));
    });
    const created = rec.ack?.created;
    const createdModel = i.kind in CREATES ? CREATES[i.kind as keyof typeof CREATES] : undefined;
    const held = () => (createdModel && created ? env.pool.model(createdModel).get(created.id) !== undefined : effectHeld(env.pool, i, env.userId));
    let arrived: Promise<unknown>;
    // Unheld groups cannot reach the echo here and provide no confirmation timing.
    const shown = env.pool.groupEntities(group).size > 0;
    if (!shown) arrived = Promise.resolve();
    else if (v !== undefined) {
      arrived = env.whenSynced(group, v, ctrl.signal);
      // Deferred hot-row changes are not covered by the echo; keep the layer until the effect or HOT_WAIT_MS.
      if (HOT_KINDS.has(i.kind)) arrived = arrived.then(() => new Promise<void>((resolve) => {
        if (held()) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(t);
          off?.();
          resolve();
        };
        const t = setTimeout(done, HOT_WAIT_MS);
        off = env.pool.onApplied(() => {
          if (held()) done();
        });
      }));
      if (env.barrier) timers.push(setTimeout(() => {
        this.barrier();
      }, env.barrierAfter ?? 3000));
    } else {
      arrived = new Promise<void>((resolve) => {
        if (held()) {
          resolve();
          return;
        }
        off = env.pool.onApplied(() => {
          if (held()) resolve();
        });
      });
    }
    let reached: boolean;
    try {
      reached = await Promise.race([arrived.then(() => true, () => true), timeout.then(() => false)]);
      // After an unconfirmed write, bypass pool shortcuts for subsequent intents in this chain.
      if (!reached) this.stale.add(chainOf(i));
    } finally {
      for (const t of timers) clearTimeout(t);
      ctrl.abort();
      off?.();
      this.confirming.delete(rec.id);
    }
    // Delete from immediate before sampling so repeated confirmations produce one timing.
    if (reached && shown && this.immediate.delete(rec.id)) sample(RUMMutationConfirmed, this.now() - i.created);
    await this.done(rec, v === undefined ? undefined : {group, v});
  }

  private async done(rec: IntentRecord, echo: {group: string; v: number} | undefined): Promise<void> {
    await this.env.db.remove(rec.id);
    if (this.closed) return;
    this.finishLocal(rec.id);
    this.env.channel.post({t: 'done', id: rec.id, ...(echo ?? {})});
    this.kick();
  }

  private async fail(rec: IntentRecord, reason: string, refused = false): Promise<void> {
    this.immediate.delete(rec.id);
    const i = rec.intent;
    const text = intentText(i);
    // Use captured names when targets have left the pool.
    const names = this.env.names?.() ?? {};
    const now = describeIntent(i, names);
    const title = rec.title !== undefined && rec.title.length > now.length ? rec.title : now;
    const issueNumber = rec.issueNumber ?? issueNumberOf(i, names);
    const draft: DraftRecord = {
      key: failedKey(rec.id), kind: 'failed', intent: i, reason, title,
      issueId: i.issueId, repoId: i.repoId, at: this.now(), ...(text === undefined ? {} : {text}), ...(refused ? {refused} : {}),
      ...(issueNumber === undefined ? {} : {issueNumber}),
    };
    const ok = await this.env.db.fail(rec.id, draft);
    if (this.closed || !ok) return;
    count(RUMIntentFailed);
    this.apply(() => {
      this.forget(rec.id);
      this.drafts.set(draft.key, draft);
    });
    this.env.channel.post({t: 'failed', id: rec.id, draft});
    if (this.visible()) this.env.onFailed?.(draft);
    this.kick();
    if (i.kind in CREATES && 'tempId' in i) {
      const temp = i.kind === 'issue.create' ? i.issueId : tempNum(i.tempId);
      for (const r of [...this.records.values()]) {
        if (tempRefs(r.intent).includes(temp) || (i.kind === 'issue.create' && r.intent.issueId === temp)) await this.fail(r, 'It depends on a change that could not be made.');
      }
    }
  }

  private revoked(group: string): Promise<void> {
    return this.dropped(group, 'You no longer have access to this.');
  }

  /** Preserve failed targets as drafts; in-flight requests decide from their own answers. */
  private async dropped(group: string, reason: string): Promise<void> {
    for (const r of [...this.records.values()]) {
      const i = r.intent;
      if (`repo:${String(i.repoId)}` !== group && `issue:${String(i.issueId)}` !== group) continue;
      if (this.sending.has(r.id) || r.state === 'acked') continue;
      await this.fail(r, reason, true);
    }
  }

  private barrier(): void {
    if (!this.env.barrier) return;
    if (this.barrierPending) {
      this.barrierAgain = true;
      return;
    }
    this.barrierPending = this.env.barrier().catch(() => undefined).finally(() => {
      this.barrierPending = undefined;
      if (this.barrierAgain && this.confirming.size) {
        this.barrierAgain = false;
        this.barrier();
      }
      this.barrierAgain = false;
    });
  }
}

function textTarget(i: Intent): string | undefined {
  if (i.kind === 'issue.body') return `body:${String(i.issueId)}`;
  if (i.kind === 'comment.edit' || i.kind === 'comment.delete') return `comment:${String(i.commentId)}`;
  return undefined;
}

/** Serializes a chain except edits blocked by another text’s conflict or an unresolved create. */
function holdsBack(r: IntentRecord, rec: IntentRecord, known: (temp: number) => boolean, parkedTargets: ReadonlySet<string>): boolean {
  if (chainOf(r.intent) !== chainOf(rec.intent)) return false;
  const target = textTarget(r.intent);
  const same = target !== undefined && target === textTarget(rec.intent);
  if (r.state === 'parked' || (target !== undefined && parkedTargets.has(target))) return same;
  return tempRefs(r.intent).every(known);
}

function strip(i: Intent): IntentInput {
  const {id: _id, key: _key, created: _created, ...input} = i;
  return input;
}

function valueOf(i: Intent): unknown {
  switch (i.kind) {
    case 'issue.state':
      return i.state;
    case 'issue.title':
      return i.title;
    case 'issue.milestone':
      return i.milestoneId;
    case 'issue.deadline':
      return i.due;
    default:
      return undefined;
  }
}

function issueNumberOf(i: Intent, names: Names): number | undefined {
  return i.issueId > 0 && !i.kind.startsWith('notification.') ? names.issue?.(i.issueId) : undefined;
}

function removes(i: Intent): boolean {
  switch (i.kind) {
    case 'comment.delete':
      return true;
    case 'issue.label':
    case 'issue.dependency':
    case 'issue.reviewer':
    case 'issue.subscribe':
    case 'reaction':
      return !i.add;
    case 'issue.pin':
      return !i.pinned;
    case 'issue.lock':
      return !i.locked;
    default:
      return false;
  }
}

async function createdId(i: Intent, res: Response): Promise<{id: number; number?: number} | undefined> {
  if (!(i.kind in CREATES)) return undefined;
  const j = await json(res);
  const id = j?.id;
  if (typeof id !== 'number') return undefined;
  return typeof j?.number === 'number' ? {id, number: j.number} : {id};
}

/** Missing/unreadable label lists are assumed to include the label. */
async function hasLabel(res: Response, labelId: number): Promise<boolean> {
  try {
    const j: unknown = await res.clone().json();
    if (!Array.isArray(j)) return true;
    return j.some((l: unknown) => typeof l === 'object' && l !== null && (l as {id?: unknown}).id === labelId);
  } catch {
    return true;
  }
}

async function json(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const j: unknown = await res.clone().json();
    return j && typeof j === 'object' ? j as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const REFUSALS: [RegExp, string][] = [
  [/max(?:imum)? number of pinned issues/i, 'Forgejo pins only a few issues per repository, and that many are pinned already: unpin one first.'],
  [/still has open dependencies/i, 'It is blocked by issues that are still open: close those first, or remove the dependency.'],
];

function refusal(said: string): string | undefined {
  return REFUSALS.find(([re]) => re.test(said))?.[1];
}

function message(j: Record<string, unknown> | undefined, status: number, i: Intent): string {
  const said = typeof j?.message === 'string' ? j.message.trim().slice(0, 300) : '';
  if (said && !internal(said)) {
    const known = refusal(said);
    if (known) return known;
    return /[.!?]$/.test(said) ? said.charAt(0).toUpperCase() + said.slice(1) : `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
  }
  if (status === 404) return `${subjectOf(i)} is not there any more, or you cannot see it.`;
  if (status === 403) return 'You are not allowed to do this.';
  return `Forgejo answered ${String(status)}.`;
}

function internal(said: string): boolean {
  return /^\w+\.?$/.test(said) && (/^(Is)?Err[A-Z]/.test(said) || /[a-z][A-Z]/.test(said));
}

function subjectOf(i: Intent): string {
  switch (i.kind) {
    case 'comment.edit':
    case 'comment.delete':
    case 'comment.resolve':
      return 'The comment';
    case 'reaction':
      return i.commentId ? 'The comment' : 'The issue';
    case 'issue.create':
      return 'The repository';
    case 'notification.status':
    case 'notification.readAll':
      return 'The notification';
    default:
      return 'The issue';
  }
}

export type {IntentRecord, DraftRecord} from './store.ts';
export {isTemp};
