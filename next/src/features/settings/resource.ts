// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Repository-scoped keys: revoking the repository purges its settings with its content. */
export function settingsKey(repoId: number, what: string): string {
  return `settings:${String(repoId)}:${what}`;
}

/** Limit concurrent calls to `limit`. */
export async function eachLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}
