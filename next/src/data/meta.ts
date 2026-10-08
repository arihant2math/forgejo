// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The `meta` store, cached in memory: values are read once at start and
// written back by the persister in the same flush as the entities (the last
// transaction of a flush), so what is persisted never claims more than the
// persisted entities hold.

export class MetaCache {
  private readonly values: Map<string, unknown>;
  private dirty = new Set<string>();

  constructor(initial?: Map<string, unknown>) {
    this.values = new Map(initial);
  }

  /** A value, typed by the caller (meta values are whatever was set). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the stored type
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

  /** Marks entries dirty again (a failed flush), unless they changed meanwhile. */
  restoreDirty(entries: Map<string, unknown>): void {
    for (const k of entries.keys()) this.dirty.add(k);
  }
}
