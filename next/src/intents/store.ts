// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Any tab adds durable intents; only the leader updates/removes them. Auto-incremented seq orders all tabs.
// Move queue records to drafts or completion atomically so crashes cannot duplicate or lose work.
// Ignore updates to concurrently removed records to prevent resurrection.

import {done, DRAFTS, INTENTS, META, request} from '../data/idb.ts';
import type {Intent} from './intents.ts';
import type {ApiRequest} from './rest.ts';

export type IntentState = 'queued' | 'acked' | 'parked';

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
  intent: Intent;
  state: IntentState;
  /** Attempts of the current key that got no definite answer. */
  attempts: number;
  /** Frozen with intent.key; every retry must send this exact request. */
  req?: ApiRequest;
  /** acked: the answer's sync id (when echoed) and the entity a create made. */
  ack?: {v?: number; created?: {id: number; number?: number}};
  note?: string;
  conflict?: Conflict;
  /** A scalar set over someone else's newer value (told to the user once it is acked). */
  override?: {theirs: unknown; who: number};
  /** ms since epoch of the last change. */
  updated: number;
  /** Capture names before targets leave the pool so failed drafts remain identifiable. */
  title?: string;
  /** Capture the issue number so drafts identify deleted targets. */
  issueNumber?: number;
}

export interface DraftRecord {
  /** `failed:<intent id>` for a failed intent; callers choose their own keys for texts (`text:…`). */
  key: string;
  kind: 'failed' | 'text';
  /** failed: the intent that could not be carried out. */
  intent?: Intent;
  reason?: string;
  /** Definitive refusal: do not offer a retry that would fail again. */
  refused?: boolean;
  text?: string;
  /** Preserve the editor’s base across restoration for correct three-way merging. */
  base?: {text: string; version: number; updated?: string | undefined};
  /** Review comment’s diff anchor, held until review submission (code/review.ts). */
  anchor?: {path: string; side: 'old' | 'new'; line: number; commit: string};
  title: string;
  issueId?: number;
  repoId?: number;
  issueNumber?: number;
  /** ms since epoch. */
  at: number;
}

export const failedKey = (intentId: string) => `failed:${intentId}`;

const REMAPS = 'intentRemaps';
const MAX_REMAPS = 500;

export class IntentDb {
  private readonly dbp: Promise<IDBDatabase>;

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

  /** Adds once, atomically replacing a draft or parked intent and preserving the latter’s queue position. */
  async add(rec: IntentRecord, replaces: {draft?: string; intent?: string} = {}): Promise<IntentRecord> {
    const tx = await this.tx([INTENTS, DRAFTS], 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    let out: IntentRecord;
    const existing = await request(store.index('id').get(rec.id) as IDBRequest<IntentRecord | undefined>);
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

  /** Atomically updates existing records only; returns which survived concurrent removal. */
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
    // Store the remap with the ack so future intents and reloads resolve the temporary id.
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

  async remove(id: string): Promise<void> {
    const tx = await this.tx(INTENTS, 'readwrite');
    const store = tx.objectStore(INTENTS);
    const finished = done(tx);
    const key = await request(store.index('id').getKey(id));
    if (key !== undefined) store.delete(key);
    await finished;
  }

  /** Atomically moves an intent to drafts; false if another tab already finished it. */
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
