// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Persist meta in the last entity-flush transaction so positions never outrun records.

export class MetaCache {
  private readonly values: Map<string, unknown>;
  private dirty = new Set<string>();

  constructor(initial?: Map<string, unknown>) {
    this.values = new Map(initial);
  }

  get<T>(key: string): T | undefined {
    const v: unknown = this.values.get(key);
    return v as T | undefined;
  }

  /** Sets a value; it must not be mutated afterwards (the persister writes it as is). */
  set(key: string, value: unknown): void {
    this.values.set(key, value);
    this.dirty.add(key);
  }

  delete(key: string): void {
    this.values.delete(key);
    this.dirty.add(key);
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }

  get isDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** The changed entries since the last call (undefined = deleted). */
  takeDirty(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const k of this.dirty) out.set(k, this.values.get(k));
    this.dirty = new Set();
    return out;
  }

  /** Marks failed-flush keys dirty again; the next flush uses current values. */
  restoreDirty(entries: Map<string, unknown>): void {
    for (const k of entries.keys()) this.dirty.add(k);
  }
}
