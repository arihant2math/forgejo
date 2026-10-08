// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The durable offline queue (PLAN §5.3, §5.4) in the user's IndexedDB:
//
//   intents   one record per intent not confirmed yet, keyed by `seq` (an
//             autoIncrement key: the queue's order, the same for every tab),
//             looked up by intent id. Any tab adds the intents its user makes
//             (durable before anything is sent); only the leader tab changes
//             or removes them (executor.ts).
//   drafts    what must never be lost when an intent cannot be carried out:
//             the failed intent with the user's text (the "Unsynced changes"
//             panel: retry / copy / discard), and texts being typed (`text`).
//
// Every step that moves an intent between states runs in one transaction,
// so a crash at any point leaves it in exactly one place: queued, or a
// draft, or done (deleted) — never two, never none. Writes of a record that
// another tab removed meanwhile are dropped, never resurrected.

import {done, DRAFTS, INTENTS, META, request} from '../data/idb.ts';
import type {Intent} from './intents.ts';
import type {ApiRequest} from './rest.ts';

export type IntentState = 'queued' | 'acked' | 'parked';

/** A body/comment conflict the user resolves in the editor. */
export interface Conflict {
  /** The server's text and its content_version (the base of the next attempt). */
  theirs: string;
  version: number;
  /** comment.edit: the server's updated_at. */
  updated?: string;
  /** The 3-way merge with conflict markers (the editor's starting point). */
  merged: string;
}

export interface IntentRecord {
  /** IndexedDB key (absent before the record is added). */
  seq?: number;
  id: string;
  /** The intent as it is now: temporary ids remapped, bodies rebased after a merge. */
  intent: Intent;
  state: IntentState;
  /** Attempts of the current key that got no definite answer. */
  attempts: number;
  /** The request, frozen with `intent.key` at its first attempt (B7: a retry must be the same request). */
  req?: ApiRequest;
  /** acked: the answer's sync id (when echoed) and the entity a create made. */
  ack?: {v?: number; created?: {id: number; number?: number}};
  /** What is holding it up (shown in the panel). */
  note?: string;
  /** parked: the conflict the user resolves. */
  conflict?: Conflict;
  /** A scalar set over someone else's newer value (told to the user once it is acked). */
  override?: {theirs: unknown; who: number};
  /** ms since epoch of the last change. */
  updated: number;
}

export interface DraftRecord {
  /** `failed:<intent id>` for a failed intent; callers choose their own keys for texts (`text:…`). */
  key: string;
  kind: 'failed' | 'text';
  /** failed: the intent that could not be carried out. */
  intent?: Intent;
  /** failed: why. */
  reason?: string;
  /** The text the user typed. */
  text?: string;
  /** text: what the edit is based on (an editor restored from it keeps its base: a 3-way merge stays right). */
  base?: {text: string; version: number; updated?: string | undefined};
  /** What it was ("Editing the description of #12"). */
  title: string;
  issueId?: number;
  repoId?: number;
  /** ms since epoch. */
  at: number;
}

export const failedKey = (intentId: string) => `failed:${intentId}`;

/** The meta record of the remapped temporary ids, and how many are kept. */
const REMAPS = 'intentRemaps';
const MAX_REMAPS = 500;

export class IntentDb {
  private readonly dbp: Promise<IDBDatabase>;

  /** The user's database (data/idb.ts layout), or a promise of it (tests). */
  constructor(db: IDBDatabase | Promise<IDBDatabase>) {
    this.dbp = Promise.resolve(db);
  }

  private async tx(stores: string | string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.dbp).transaction(stores, mode);
  }

  /** Every queued intent, in queue order. */
  async list(): Promise<IntentRecord[]> {
    const tx = await this.tx(INTENTS, 'readonly');
    return request(tx.objectStore(INTENTS).getAll() as IDBRequest<IntentRecord[]>);
  }

  async get(id: string): Promise<IntentRecord | undefined> {
    const tx = await this.tx(INTENTS, 'readonly');
    return request(tx.objectStore(INTENTS).index('id').get(id) as IDBRequest<IntentRecord | undefined>);
  }

  /**
   * Adds a new intent (and, atomically, removes what it replaces: a failed
   * intent's draft being retried; a parked intent being resolved, whose place
   * in the queue it takes). Returns the
   * stored record (with its seq); an intent already stored is not added twice.
   */
  async add(rec: IntentRecord, replaces: {draft?: string; intent?: string} = {}): Promise<IntentRecord> {
    const tx = await this.tx([INTENTS, DRAFTS], 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    let out: IntentRecord;
    const existing = await request(store.index('id').get(rec.id) as IDBRequest<IntentRecord | undefined>);
    // A resolved intent takes the place of the one it replaces in the queue (its entity's order is kept).
    const old = replaces.intent === undefined ? undefined : await request(store.index('id').getKey(replaces.intent)) as number | undefined;
    if (existing) out = existing;
    else if (old !== undefined) {
      out = {...rec, seq: old};
      store.put(out);
    } else {
      const seq = await request(store.add(withoutSeq(rec)) as IDBRequest<number>);
      out = {...rec, seq};
    }
    if (replaces.draft) tx.objectStore(DRAFTS).delete(replaces.draft);
    await finished;
    return out;
  }

  /**
   * Writes the new state of queued records (all or nothing). A record no longer
   * there (done or failed meanwhile, by another tab) is not written back; the
   * result tells which were.
   */
  async update(recs: readonly IntentRecord[], remap?: readonly [number, number]): Promise<boolean[]> {
    const tx = await this.tx(remap ? [INTENTS, META] : INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    const out: boolean[] = [];
    for (const r of recs) {
      if (r.seq === undefined) {
        out.push(false);
        continue;
      }
      const cur = await request(store.get(r.seq) as IDBRequest<IntentRecord | undefined>);
      const ok = cur?.id === r.id;
      if (ok) store.put(r);
      out.push(ok);
    }
    // A create's temporary id → the server's, with its ack (an intent made later under the temporary id, or
    // read after a reload, is remapped from this).
    if (remap && out[0]) {
      const meta = tx.objectStore(META);
      const prev = (await request(meta.get(REMAPS) as IDBRequest<{v?: [number, number][]} | undefined>))?.v ?? [];
      meta.put({k: REMAPS, v: [...prev.filter(([f]) => f !== remap[0]), remap].slice(-MAX_REMAPS)});
    }
    await finished;
    return out;
  }

  /** Temporary ids replaced by the server's (the newest MAX_REMAPS). */
  async remaps(): Promise<[number, number][]> {
    const tx = await this.tx(META, 'readonly');
    return (await request(tx.objectStore(META).get(REMAPS) as IDBRequest<{v?: [number, number][]} | undefined>))?.v ?? [];
  }

  /** The intent is done (confirmed, or nothing to do). */
  async remove(id: string): Promise<void> {
    const tx = await this.tx(INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    const key = await request(store.index('id').getKey(id));
    if (key !== undefined) store.delete(key);
    await finished;
  }

  /**
   * The intent cannot be carried out: it leaves the queue and its draft is
   * kept, in one transaction. False when it was not queued any more (another
   * tab finished it): no draft then.
   */
  async fail(id: string, draft: DraftRecord): Promise<boolean> {
    const tx = await this.tx([INTENTS, DRAFTS], 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    const key = await request(store.index('id').getKey(id));
    if (key !== undefined) {
      store.delete(key);
      tx.objectStore(DRAFTS).put(draft);
    }
    await finished;
    return key !== undefined;
  }

  async drafts(): Promise<DraftRecord[]> {
    const tx = await this.tx(DRAFTS, 'readonly');
    return request(tx.objectStore(DRAFTS).getAll() as IDBRequest<DraftRecord[]>);
  }

  async putDraft(d: DraftRecord): Promise<void> {
    const tx = await this.tx(DRAFTS, 'readwrite');
    const finished = done(tx);
    tx.objectStore(DRAFTS).put(d);
    await finished;
  }

  async deleteDraft(key: string): Promise<void> {
    const tx = await this.tx(DRAFTS, 'readwrite');
    const finished = done(tx);
    tx.objectStore(DRAFTS).delete(key);
    await finished;
  }

  /** Unsynced work: queued intents and failed drafts (the sign-out warning). */
  async unsynced(): Promise<number> {
    const tx = await this.tx([INTENTS, DRAFTS], 'readonly');
    const [n, drafts] = await Promise.all([
      request(tx.objectStore(INTENTS).count()),
      request(tx.objectStore(DRAFTS).getAll() as IDBRequest<DraftRecord[]>),
    ]);
    return n + drafts.filter((d) => d.kind === 'failed').length;
  }
}

function withoutSeq(rec: IntentRecord): Omit<IntentRecord, 'seq'> {
  const {seq: _seq, ...rest} = rec;
  return rest;
}
