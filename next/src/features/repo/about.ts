// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a repository's side pane (AboutSidebar.tsx) derives from synced data
// and the code cache. Pure (about.test.ts).

import type {Release} from '../../protocol/types.gen.ts';
import type {Share, ShareTone} from '../../ui/index.ts';

/** How many languages get a colour of their own; the rest fold into "Other". */
export const LANGUAGE_SLOTS = 5;

/**
 * The languages bar's shares from Forgejo's language statistics (name → bytes): the largest LANGUAGE_SLOTS
 * by size each in its series slot, in that order, and the rest (with Forgejo's own "other") as one "Other".
 * Anything that is not a positive byte count is ignored.
 */
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
  // Exactly one more than the slots: it is shown by its own name (as "Other" it would say less in the same room).
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

/** A license file at the top of a tree (LICENSE, LICENSE.md, COPYING, LICENCE-MIT, …): the plain names first. */
export function licenseOf<T extends {name: string; type: string}>(entries: readonly T[]): T | undefined {
  const files = entries.filter((e) => e.type === 'blob' && /^(?:un)?licen[cs]e(?:[.-][\w.-]+)?$|^copying(?:\.[\w-]+)?$/i.test(e.name));
  return files.find((e) => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(e.name)) ?? files[0];
}

export interface ReleaseSummary {
  /** Published releases (not drafts, not bare tags), pre-releases included. */
  count: number;
  /** The newest of them that is not a pre-release (GitHub's "Latest"), else the newest pre-release. */
  latest: Release | undefined;
}

/** The Releases section's count and its latest release. */
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

/** Tags: every published release and bare tag that names a commit (the Tags view's rows). */
export function tagCount(all: Iterable<Release>): number {
  let n = 0;
  for (const r of all) if (!r.draft && r.sha) n++;
  return n;
}

/** "1 star", "2 stars". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
