// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The intent queue (PLAN §5.3, §5.4): optimistic online, durable offline.
//
// Every tab:
//   submit(input)  → the overlay layer is applied synchronously (the UI shows
//                    the change in the same frame), the intent is stored in
//                    IndexedDB with a fresh Idempotency-Key (durable before
//                    anything is sent) and announced to the other tabs, which
//                    apply the same layer. A follower forwards nothing else:
//                    the stored record is the hand-over, the leader picks it up.
//   mirror         → the queue as the leader reports it (changed, done, failed,
//                    remapped), plus a full re-read from IndexedDB when this
//                    tab takes over or comes back to the foreground.
//
// The leader tab flushes (`pump`), only after the sync session caught up
// (flush rule 1: the base state is current), only while signed in:
//   per entity (chainOf) one intent at a time, in queue order (rule 2); an
//   intent that refers to an entity created offline waits for its create and
//   the remap of the temporary id; the request is built against the pool as
//   it is then and frozen with the key in IndexedDB before it is sent, so a
//   retry — by this tab or by the next leader after a crash — is the same
//   request under the same key (B7 replays it: no duplicate); unknown
//   outcomes retry with exponential backoff (rule 3), 409 "in flight" waits.
//
// Conflict policies (PLAN §5.4, intents.ts POLICY):
//   set        sent as add/remove against the current server set; skipped
//              when the server already shows it.
//   scalar     last writer wins; when the server value changed since the
//              user's `base`, the user is told whose change was overridden,
//              with one-click undo (`overrides`).
//   text       issue body: 3-way merge of base / server / mine (merge3.ts)
//              when the server text moved, sent with expected_version (B9);
//              a clean merge is sent under a new key, a conflict parks the
//              intent and the editor shows it (`resolve`). Comment edit:
//              updated_at must not have changed, else parked the same way.
//   create     the answer's id replaces the temporary id in the queue (one
//              transaction with the ack), the pool views (`remapped`) and the
//              URL (`onRemap`).
//   rejected   (4xx, target deleted, permission lost, group revoked): the
//              layer is removed and the intent with the user's text goes to
//              `drafts` in the same transaction ("Unsynced changes": retry,
//              copy, discard). Nothing is ever dropped silently.
//
// Confirmation: 2xx with X-Livesync-Sync-Id = v → the layer is dropped once
// the pool holds its group up to v (Data.whenSynced: no flicker), without an
// echo once the pool shows the intent's own effect; ≤ 60 s either way.

import {observable, reaction, runInAction, untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import {HeaderIdempotencyKey, HeaderSyncID} from '../protocol/types.gen.ts';
import {effectHeld, lastChangedBy, scalarField, serverScalar} from './effects.ts';
import {chainOf, CREATES, describeIntent, groupOf, type Intent, type IntentInput, intentOps, intentText, isTemp, type Names, newIntent, POLICY, remapIntent, tempNum, tempRefs, uuid} from './intents.ts';
import {merge3} from './merge3.ts';
import type {Overlay} from './overlay.ts';
import {type ApiRequest, NotReady, requestFor, UnsendableIntent} from './rest.ts';
import {type Conflict, type DraftRecord, failedKey, type IntentDb, type IntentRecord} from './store.ts';

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
  /** A tab asks the leader to take a queued intent back (discard). */
  | {t: 'discard'; id: string}
  /** A tab took over: the others re-read the queue (the old leader's last messages may be lost). */
  | {t: 'leader'}
  /** An override notice was undone or dismissed. */
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
  /** "status", "title", … */
  field: string;
  /** Who made the change that was overridden (0: unknown). */
  who: number;
  /** The value overridden (what undo sets back) and the user's. */
  theirs: unknown;
  mine: unknown;
  /** The intent that undoes it. */
  undo: IntentInput;
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
  /** Data.on('caughtUp'). */
  onCaughtUp(fn: () => void): () => void;
  /** Data.on('revoked'): the viewer lost a group. */
  onRevoked(fn: (group: string) => void): () => void;
  /** Data.on('issueDropped'): an issue was deleted or moved out of reach. */
  onIssueDropped?(fn: (issueId: number) => void): () => void;
  /** Data.whenSynced. */
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
  /** An intent could not be carried out: its draft is in the panel. */
  onFailed?(d: DraftRecord): void;
  onOverride?(o: Override): void;
  /** An intent was parked on a conflict. */
  onConflict?(rec: IntentRecord): void;
  /** A temporary id was replaced by the server's (the URL of a created issue). */
  onRemap?(r: {model: string; from: number; to: number; number?: number}): void;
}

/** Requests in flight at once, across entities. */
const MAX_SENDS = 6;

/** An intent the user may still take back (never attempted, or parked). */
export function discardable(rec: IntentRecord): boolean {
  return rec.state === 'parked' || (rec.state === 'queued' && rec.req === undefined);
}

export class Intents {
  private readonly env: IntentEnv;
  /** The queue as this tab knows it (id → record). */
  readonly records = observable.map<string, IntentRecord>({}, {deep: false});
  /** Drafts (failed intents, kept texts) by key. */
  readonly drafts = observable.map<string, DraftRecord>({}, {deep: false});
  /** Temporary ids replaced by the server's (Comment/Issue/Review), for views that list created entities. */
  readonly remapped = observable.map<number, number>({}, {deep: false});
  /** Overridden changes to tell the user about (newest last). */
  readonly overrides = observable.array<Override>([], {deep: false});
  /** Per entity (issue id): queued intents, for the pending badges. */
  private readonly perIssue = observable.map<number, number>({}, {deep: false});
  /** Parked conflicts by text target (`body:<issue>`, `comment:<id>`) → record id (the editors observe one key). */
  private readonly parked = observable.map<string, string>({}, {deep: false});
  /** Intents whose storing failed: kept in memory (a re-read must not drop them). */
  private readonly memoryOnly = new Set<string>();
  /** Resolves once the stored queue is in the overlay. */
  readonly ready: Promise<void>;

  /** Submitted here and not stored yet (a re-read must not drop them). */
  private readonly unstored = new Set<string>();
  // Leader state.
  private readonly sending = new Set<string>();
  private readonly confirming = new Set<string>();
  private readonly nextAt = new Map<string, number>();
  private wake: ReturnType<typeof setTimeout> | undefined;
  private pumpQueued = false;
  private orphanCheck = false;
  /** Entities whose last write was given up on without its echo: until their queue empties, the pool's word on them is not trusted (no "already done" shortcut; the server decides). */
  private readonly stale = new Set<string>();
  /** Signed out: nothing is sent until the session is live again (the queue is held, PLAN §4.9). */
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
    this.cleanups.push(env.onRevoked((group) => {
      if (this.env.isLeader()) void this.revoked(group);
    }));
    if (env.onIssueDropped) {
      this.cleanups.push(env.onIssueDropped((issueId) => {
        if (this.env.isLeader()) void this.dropped(`issue:${String(issueId)}`, 'The issue was deleted, or you can no longer see it.');
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
    // An entity created offline and already created on the server: its server id (it may still show under its temporary one).
    const i = this.remapKnown(newIntent(input, this.now()));
    const rec: IntentRecord = {id: i.id, intent: i, state: 'queued', attempts: 0, updated: this.now()};
    this.unstored.add(i.id);
    this.apply(() => {
      if (replaces.intent) {
        // Its place in the queue (store.ts add): sent where the one it replaces was.
        const seq = this.records.get(replaces.intent)?.seq;
        if (seq !== undefined) rec.seq = seq;
        this.forget(replaces.intent);
      }
      if (replaces.draft) this.drafts.delete(replaces.draft);
      this.track(rec);
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
      // Not durable (storage full or broken): it still runs in this tab (a re-read keeps it), and the user is told.
      this.unstored.delete(i.id);
      this.memoryOnly.add(i.id);
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

  /** Failed intents kept as drafts. */
  get failedCount(): number {
    let n = 0;
    for (const d of this.drafts.values()) if (d.kind === 'failed') n++;
    return n;
  }

  /** Observable: the number of intents pending on an issue (its pending badge). */
  pendingOn(issueId: number): number {
    return this.perIssue.get(issueId) ?? 0;
  }

  /** The parked conflict of an entity's text edit, if any (the editor shows it). Observes that entity's conflict only. */
  conflictOf(kind: 'issue.body' | 'comment.edit', id: number): IntentRecord | undefined {
    const rec = this.parked.get(kind === 'issue.body' ? `body:${String(id)}` : `comment:${String(id)}`);
    return rec === undefined ? undefined : untracked(() => this.records.get(rec));
  }

  /**
   * Resolves a parked conflict with the user's text: a new intent based on the
   * server's text and version (a new key), replacing the parked one atomically.
   */
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

  /** Discards a draft (the user chose to). */
  async discardDraft(key: string): Promise<void> {
    await this.env.db.deleteDraft(key);
    this.apply(() => this.drafts.delete(key));
    this.env.channel.post({t: 'draftGone', key});
  }

  /** Puts a discarded draft back (undo). */
  async restoreDraft(d: DraftRecord): Promise<void> {
    await this.env.db.putDraft(d);
    this.apply(() => this.drafts.set(d.key, d));
    this.env.channel.post({t: 'draft', draft: d});
  }

  /** Keeps a text (an editor's content) as a draft. */
  async keepText(d: Omit<DraftRecord, 'kind' | 'at'>): Promise<void> {
    const draft: DraftRecord = {...d, kind: 'text', at: this.now()};
    await this.env.db.putDraft(draft);
    this.apply(() => this.drafts.set(draft.key, draft));
    this.env.channel.post({t: 'draft', draft});
  }

  /**
   * Takes back a queued intent the user no longer wants (never attempted, or
   * parked: see `discardable`). The leader does it (it knows what is in flight).
   */
  discard(id: string, again = true): void {
    if (!this.env.isLeader()) {
      this.env.channel.post({t: 'discard', id});
      return;
    }
    const rec = this.records.get(id);
    // Not known yet (a take-over, a follower's intent just stored): read the queue, then decide.
    if (!rec && again) {
      void this.reread().then(() => {
        this.discard(id, false);
      });
      return;
    }
    if (!rec || this.sending.has(id) || !discardable(rec)) return;
    void this.env.db.remove(id).then(() => {
      this.finishLocal(id);
      this.env.channel.post({t: 'done', id});
    });
  }

  /** Undoes an overridden change: sets back the value that was overridden. */
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

  /** This tab leads now: the queue in IndexedDB is the truth (a dead leader's last messages may be lost). */
  private takeOver(): void {
    void this.ready.then(() => this.reread()).then(() => {
      this.env.channel.post({t: 'leader'});
      this.kick();
    }, (err: unknown) => {
      console.error('intents: reading the queue failed', err);
    });
  }

  /** Re-reads the queue and the drafts from IndexedDB (what another tab or a dead leader did). */
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

  // ---- mirror -----------------------------------------------------------

  /** One MobX action (observers see a whole change at once). */
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

  /** A record's new state; its layer follows its intent (remapped, merged). Nothing happens when nothing changed. */
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

  /** Keeps `parked` (text target → parked record) in step with a record's change. */
  private noteParked(before: IntentRecord | undefined, after: IntentRecord | undefined): void {
    const was = before?.state === 'parked' ? textTarget(before.intent) : undefined;
    const now = after?.state === 'parked' ? textTarget(after.intent) : undefined;
    if (was !== undefined && was !== now && this.parked.get(was) === before?.id) this.parked.delete(was);
    if (now !== undefined && after && this.parked.get(now) !== after.id) this.parked.set(now, after.id);
  }

  /** The intent with the temporary ids it refers to replaced by the server's, where those are known. */
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
          void Promise.race([this.env.whenSynced(m.group, m.v, AbortSignal.timeout(this.env.confirmTimeout ?? 60_000)), sleepMs(this.env.confirmTimeout ?? 60_000)])
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
        if (this.env.isLeader()) this.discard(m.id);
        break;
      case 'leader':
        if (!this.env.isLeader()) void this.reread();
        break;
      case 'overrideGone':
        this.dismissOverride(m.id, false);
        break;
    }
  }

  /** Whether this tab is the one the user looks at (notices show there only). */
  private visible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  // ---- leader: flush ----------------------------------------------------

  private now(): number {
    return (this.env.now ?? Date.now)();
  }

  /**
   * Whether the leader may send now (PLAN §5.4 rule 1, §4.9). The sync client
   * is `live` only once every subscription of its session caught up
   * (caught_up), and stays so across a short offline spell its socket
   * survives: the base state is current then.
   */
  private get open(): boolean {
    return !this.closed && !this.held && this.env.isLeader() && this.env.connection() === 'live' && this.env.online();
  }

  /** Runs the pump soon (coalesced). */
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
    // Acked intents are confirmed whether or not sending is open (a new leader after a crash).
    for (const rec of this.records.values()) if (rec.state === 'acked' && !this.confirming.has(rec.id)) void this.confirm(rec);
    if (!this.open) return;
    const now = this.now();
    const blocked = new Set<string>();
    let soonest = Number.POSITIVE_INFINITY;
    const order = [...this.records.values()].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) || a.intent.created - b.intent.created);
    // A parked conflict holds back only later edits of the same text (`textTarget`): the user resolves it
    // in the editor while the issue's other changes go on.
    const parkedTargets = new Map<string, IntentRecord>();
    const waiting: IntentRecord[] = [];
    for (const rec of order) {
      const i = rec.intent;
      const chain = chainOf(i);
      const target = textTarget(i);
      if (rec.state === 'parked') {
        if (target) parkedTargets.set(target, rec);
        // An edit parked on a comment that is gone (deleted on the server): it cannot be made, its text is kept.
        if (i.kind === 'comment.edit' && this.env.pool.groupEntities(`issue:${String(i.issueId)}`).size > 0 && !untracked(() => this.env.pool.model('Comment').get(i.commentId))) {
          void this.fail(rec, 'The comment was deleted.');
        }
        continue;
      }
      if (blocked.has(chain)) continue;
      const parkedHere = target === undefined ? undefined : parkedTargets.get(target);
      if (parkedHere) {
        // Deleting the comment makes its parked edit moot: the edit goes to the drafts (its text kept).
        if (i.kind === 'comment.delete') void this.fail(parkedHere, 'You deleted this comment; your edit is kept here.');
        blocked.add(chain);
        continue;
      }
      // Refers to an entity created offline: it waits for the create and its remap (without holding the
      // issue's other changes back: the create itself may be behind it).
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
      if (rec.state === 'acked' || this.sending.has(rec.id) || this.unstored.has(rec.id) || this.sending.size >= MAX_SENDS) continue;
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

  /**
   * Adds the stored intents this tab did not know; whether an intent of the
   * same entity queued before `rec` is still unsent (it goes first: the pump
   * picks it next). Read from IndexedDB, the queue's truth, right before
   * sending: a take-over re-read may have taken place meanwhile.
   */
  private async unknownBefore(rec: IntentRecord): Promise<boolean> {
    const stored = await this.env.db.list();
    if (this.closed) return true;
    if (rec.seq !== undefined && !stored.some((r) => r.id === rec.id)) {
      // Finished by another tab (its message lost): nothing to send.
      this.finishLocal(rec.id);
      return true;
    }
    const unknown = stored.filter((r) => !this.records.has(r.id));
    if (unknown.length) {
      this.apply(() => {
        for (const r of unknown) this.track(r);
      });
    }
    return stored.some((r) => r.id !== rec.id && (r.seq ?? 0) < (rec.seq ?? Number.MAX_SAFE_INTEGER) && holdsBack(r, rec, (t) => this.remapped.has(t)));
  }

  /**
   * Intents that wait for a create no queued intent will make (it was discarded,
   * or it failed and the tab died before failing them): they cannot be made, and
   * fail with their text kept. Checked against IndexedDB (another tab may hold the create).
   */
  private async orphans(waiting: IntentRecord[]): Promise<void> {
    if (this.orphanCheck) return;
    this.orphanCheck = true;
    try {
      const stored = await this.env.db.list();
      const creating = new Set<number>();
      for (const r of stored) {
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

  /** Persists a record's new state (unless it is gone); false when another tab finished it meanwhile. */
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
    const attempts = attempt ? rec.attempts + 1 : rec.attempts;
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
      // IndexedDB is the queue: an intent stored by a tab that died before announcing it (or announced to a
      // leader that died) is learnt here, and one of the same entity queued before this one goes first.
      if (await this.unknownBefore(rec)) return;
      const i = rec.intent;
      // Nothing to do: the server already shows it (a remote change did the same). The entity's earlier
      // intents are confirmed by now (the pump holds an entity's next intent until then).
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

  /**
   * Turns the intent into its request against the pool as it is now (rebasing
   * a text edit first) and freezes it with the key in IndexedDB. undefined:
   * nothing to send now (parked, or gone).
   */
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
    // Last writer wins, but the user hears about overriding someone's newer value.
    // (The entity's earlier intents are confirmed by now: the pool shows what the user saw.)
    if (POLICY[i.kind] === 'scalar' && 'base' in i) {
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
    if (merged.text === theirs && !this.stale.has(chainOf(i))) {
      // The server already has it.
      await this.done({...rec, intent: merged}, undefined);
      return undefined;
    }
    const next: IntentRecord = {...rec, intent: merged, attempts: 0, req: requestFor(merged, this.env.pool, this.env.overlay), updated: this.now()};
    delete next.note;
    const [ok] = await this.save([next]);
    return ok ? next : undefined;
  }

  private async park(rec: IntentRecord, conflict: Conflict): Promise<void> {
    const next: IntentRecord = {...rec, state: 'parked', conflict, updated: this.now()};
    delete next.req;
    const [ok] = await this.save([next]);
    if (ok && this.visible()) this.env.onConflict?.(next);
  }

  /** Sends the frozen request once; the answer decides what happens next. */
  private async attempt(rec: IntentRecord, req: ApiRequest): Promise<void> {
    const {env} = this;
    let token: string;
    try {
      token = await env.token();
    } catch (err) {
      // Signed out: held, not dropped (PLAN §4.9), until the session is live again. Anything else (the
      // token endpoint unreachable): try again later.
      if (err instanceof Error && err.name === 'SignedOut') this.held = true;
      else await this.later(rec, -1, 'Could not get a session token; retrying.', false);
      return;
    }
    const res = await this.fetch(rec, req, token);
    if (!res) return;
    if (res.status === 401) {
      const t = await env.refresh().catch(() => null);
      if (!t) {
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
        signal: AbortSignal.timeout(30_000),
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
      await this.ack(rec, res);
      return;
    }
    const after = Number(res.headers.get('Retry-After') ?? Number.NaN);
    // Retry-After in seconds (≤ 60); "0" means at once (the base backoff).
    const wait = Number.isFinite(after) && after >= 0 ? Math.max(Math.min(after, 60) * 1000, this.env.backoff ?? 1000) : -1;
    if (res.status === 409) {
      const j = await json(res);
      // B9: the text moved on the server (the current text and version are the next base).
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
      // B7: the same key is still running (an earlier attempt): wait for it, without spending attempts.
      if (res.headers.has('Retry-After')) {
        await this.later(rec, wait > 0 ? wait : this.env.backoff ?? 1000, undefined, false);
        return;
      }
      // Already so (an issue already locked) or a stale view.
      if (effectHeld(this.env.pool, i, this.env.userId)) await this.done(rec, undefined);
      else await this.fail(rec, message(j, res.status));
      return;
    }
    // Removing what is already gone.
    if (res.status === 404 && removes(i)) {
      await this.done(rec, undefined);
      return;
    }
    if (res.status === 429 || res.status >= 500) {
      await this.later(rec, wait, `Forgejo answered ${String(res.status)}; retrying.`, true);
      return;
    }
    await this.fail(rec, message(await json(res), res.status));
  }

  /** 2xx: remembered with its sync id (and a create's id, remapped in the same transaction), then confirmed. */
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
    // The remap is stored with the ack: an intent made later under the temporary id (or read after a
    // reload) is remapped from it (`remapKnown`).
    const ok = await this.save(changes, from !== undefined && created ? [from, created.id] : undefined);
    if (!ok[0]) return;
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
    const o: Override = {id: rec.id, issueId: i.issueId, repoId: i.repoId, field, who, theirs, mine, undo};
    this.apply(() => this.overrides.push(o));
    this.env.channel.post({t: 'override', override: o});
    if (this.visible()) this.env.onOverride?.(o);
  }

  /**
   * Drops the layer once the pool holds the write: the group's position
   * reached the echoed sync id (asking for a barrier when that is slow), or —
   * without an echo — once the pool shows the intent's own effect (a create:
   * its entity). Gives up after confirmTimeout (the layer goes; the pool shows
   * what it has).
   */
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
    // A group this tab does not hold never reaches v: nothing shows the write here then.
    if (env.pool.groupEntities(group).size === 0) arrived = Promise.resolve();
    else if (v !== undefined) {
      arrived = env.whenSynced(group, v, ctrl.signal);
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
    try {
      const reached = await Promise.race([arrived.then(() => true, () => true), timeout.then(() => false)]);
      // Given up without the echo: the pool may not show this write yet, so what it says of the entity is
      // not trusted for the next intents (`stale`).
      if (!reached) this.stale.add(chainOf(i));
    } finally {
      for (const t of timers) clearTimeout(t);
      ctrl.abort();
      off?.();
      this.confirming.delete(rec.id);
    }
    await this.done(rec, v === undefined ? undefined : {group, v});
  }

  /** The intent is done: removed from the queue, its layer dropped (other tabs once they hold the state). */
  private async done(rec: IntentRecord, echo: {group: string; v: number} | undefined): Promise<void> {
    await this.env.db.remove(rec.id);
    if (this.closed) return;
    this.finishLocal(rec.id);
    this.env.channel.post({t: 'done', id: rec.id, ...(echo ?? {})});
    // The entity's next intent may go now.
    this.kick();
  }

  /** It cannot be carried out: the layer goes, the intent and its text become a draft (one transaction). */
  private async fail(rec: IntentRecord, reason: string): Promise<void> {
    const i = rec.intent;
    const text = intentText(i);
    const draft: DraftRecord = {
      key: failedKey(rec.id), kind: 'failed', intent: i, reason, title: describeIntent(i, this.env.names?.() ?? {}),
      issueId: i.issueId, repoId: i.repoId, at: this.now(), ...(text === undefined ? {} : {text}),
    };
    const ok = await this.env.db.fail(rec.id, draft);
    if (this.closed || !ok) return;
    this.apply(() => {
      this.forget(rec.id);
      this.drafts.set(draft.key, draft);
    });
    this.env.channel.post({t: 'failed', id: rec.id, draft});
    if (this.visible()) this.env.onFailed?.(draft);
    this.kick();
    // What waits for a create that failed cannot happen either.
    if (i.kind in CREATES && 'tempId' in i) {
      const temp = i.kind === 'issue.create' ? i.issueId : tempNum(i.tempId);
      for (const r of [...this.records.values()]) {
        if (tempRefs(r.intent).includes(temp) || (i.kind === 'issue.create' && r.intent.issueId === temp)) await this.fail(r, 'It depends on a change that could not be made.');
      }
    }
  }

  /** group_revoked: the intents of that group cannot be made (the user's text is kept). */
  private revoked(group: string): Promise<void> {
    return this.dropped(group, 'You no longer have access to this.');
  }

  /** The intents of a repository or an issue that is gone fail (their drafts keep the text). One in flight answers for itself. */
  private async dropped(group: string, reason: string): Promise<void> {
    for (const r of [...this.records.values()]) {
      const i = r.intent;
      if (`repo:${String(i.repoId)}` !== group && `issue:${String(i.issueId)}` !== group) continue;
      if (this.sending.has(r.id) || r.state === 'acked') continue;
      await this.fail(r, reason);
    }
  }

  /** One barrier at a time for every slow echo. */
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

/** The text an intent edits (a parked conflict there holds back later edits of the same text): `body:<issue>`, `comment:<id>`. */
function textTarget(i: Intent): string | undefined {
  if (i.kind === 'issue.body') return `body:${String(i.issueId)}`;
  if (i.kind === 'comment.edit' || i.kind === 'comment.delete') return `comment:${String(i.commentId)}`;
  return undefined;
}

/**
 * Whether the earlier queued `r` must be done before `rec` is sent: same
 * entity, unless it is parked on another text, or waits for a create.
 */
function holdsBack(r: IntentRecord, rec: IntentRecord, known: (temp: number) => boolean): boolean {
  if (chainOf(r.intent) !== chainOf(rec.intent)) return false;
  if (r.state === 'parked') return textTarget(r.intent) !== undefined && textTarget(r.intent) === textTarget(rec.intent);
  return tempRefs(r.intent).every(known);
}

/** The input of an intent (for a new one with the same change). */
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

/** Intents that remove something: a 404 means it is already gone. */
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

async function json(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const j: unknown = await res.clone().json();
    return j && typeof j === 'object' ? j as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function message(j: Record<string, unknown> | undefined, status: number): string {
  if (typeof j?.message === 'string' && j.message) return j.message.slice(0, 300);
  if (status === 404) return 'It is not there any more, or you cannot see it.';
  if (status === 403) return 'You are not allowed to do this.';
  return `Forgejo answered ${String(status)}.`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type {IntentRecord, DraftRecord} from './store.ts';
export {isTemp};
