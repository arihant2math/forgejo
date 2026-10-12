// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Release} from '../../protocol/types.gen.ts';
export type ShareTone = 1 | 2 | 3 | 4 | 5 | 'other';
export interface Share {label: string; value: number; tone: ShareTone}
export function percent(value: number, total: number): string {
  if (total <= 0) return '0%';
  const n = value / total * 100;
  return n > 0 && n < 0.1 ? '<0.1%' : `${n.toFixed(1)}%`;
}

export const LANGUAGE_SLOTS = 5;

/** Byte-count shares: largest languages first, remainder grouped as Other; ignore non-positive counts. */
export function languageShares(stats: unknown): Share[] {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return [];
  const all = Object.entries(stats as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] > 0);
  let other = 0;
  const named: [string, number][] = [];
  for (const [name, bytes] of all) {
    if (name.toLowerCase() === 'other') other += bytes;
    else named.push([name, bytes]);
  }
  named.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  // A lone remaining language gets its name instead of the less informative "Other".
  const shown = named.length === LANGUAGE_SLOTS + 1 && other === 0 ? LANGUAGE_SLOTS + 1 : LANGUAGE_SLOTS;
  const out: Share[] = [];
  named.forEach(([label, value], i) => {
    if (i < shown && i < LANGUAGE_SLOTS) out.push({label, value, tone: (i + 1) as ShareTone});
    else if (i < shown) out.push({label, value, tone: 'other'});
    else other += value;
  });
  if (other > 0) out.push({label: 'Other', value: other, tone: 'other'});
  return out;
}

/** Prefer plain license filenames at the tree root. */
export function licenseOf<T extends {name: string; type: string}>(entries: readonly T[]): T | undefined {
  const files = entries.filter((e) => e.type === 'blob' && /^(?:un)?licen[cs]e(?:[.-][\w.-]+)?$|^copying(?:\.[\w-]+)?$/i.test(e.name));
  return files.find((e) => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(e.name)) ?? files[0];
}

export interface ReleaseSummary {
  /** Published releases, including pre-releases but excluding drafts and bare tags. */
  count: number;
  /** Latest stable release, falling back to the latest pre-release. */
  latest: Release | undefined;
}

export function releaseSummary(all: Iterable<Release>): ReleaseSummary {
  let count = 0;
  let latest: Release | undefined;
  let pre: Release | undefined;
  for (const r of all) {
    if (r.is_tag || r.draft) continue;
    count++;
    if (r.prerelease) {
      if (!pre || newer(r, pre)) pre = r;
    } else if (!latest || newer(r, latest)) latest = r;
  }
  return {count, latest: latest ?? pre};
}

const newer = (a: Release, b: Release) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);

/** Include published releases and bare tags with a commit. */
export function tagCount(all: Iterable<Release>): number {
  let n = 0;
  for (const r of all) if (!r.draft && r.sha) n++;
  return n;
}

export {noun as plural} from '../../app/words.ts';
