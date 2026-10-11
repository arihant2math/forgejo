// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's labels page, the pure part: the orders and the search
// (the classic page's `sort` and `q`, so a URL means the same in both UIs;
// the params themselves are app/search.ts's), the colour presets and what a
// label's form accepts.

import type {LabelSort} from '../../app/search.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {exclusiveScope} from '../issues/labels.ts';
import type {LabelCount} from './counts.ts';

/** The orders' names (app/search.ts LABEL_SORTS: by name, the default; reversed; by the open items that have it). */
export const LABEL_SORT_NAMES: Record<LabelSort, string> = {
  alphabetically: 'Alphabetically', reversealphabetically: 'Reverse alphabetically', mostissues: 'Most issues', leastissues: 'Fewest issues',
};

const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});

/** The open items that have a label (its issues and its pull requests). */
export function openCount(c: LabelCount | undefined): number {
  return c ? c.issues + c.pulls : 0;
}

/** The labels in an order; ties by name. Returns a new array. */
export function sortLabels(labels: readonly Label[], sort: LabelSort, counts: ReadonlyMap<number, LabelCount>): Label[] {
  const byName = (a: Label, b: Label) => collator.compare(a.name, b.name) || a.id - b.id;
  const out = [...labels];
  switch (sort) {
    case 'alphabetically':
      return out.sort(byName);
    case 'reversealphabetically':
      return out.sort((a, b) => byName(b, a));
    case 'mostissues':
      return out.sort((a, b) => openCount(counts.get(b.id)) - openCount(counts.get(a.id)) || byName(a, b));
    case 'leastissues':
      return out.sort((a, b) => openCount(counts.get(a.id)) - openCount(counts.get(b.id)) || byName(a, b));
  }
}

/** The labels whose name or description has every word of the search (case-insensitive). */
export function filterLabels(labels: readonly Label[], q: string | undefined): Label[] {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...labels];
  return labels.filter((l) => {
    const text = `${l.name} ${l.description}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * The preset colours of a label (the classic form's, templates/repo/issue/label_precolors.tmpl): a strong row, then a pale
 * one. Data that is sent to Forgejo as the label's colour, not a colour of this UI (those are tokens).
 */
export const LABEL_PRESETS: readonly string[] = [
  'e11d21', 'eb6420', 'fbca04', '009800', '006b75', '207de5', '0052cc', '5319e7',
  'f6c6c7', 'fad8c7', 'fef2c0', 'bfe5bf', 'bfdadc', 'c7def8', 'bfd4f2', 'd4c5f9',
].map((h) => `#${h}`);

/** A colour as Forgejo stores it ("#rrggbb", lower case) from what was typed ("abc", "#ABC", "aabbcc"), else undefined. */
export function normalizeColor(input: string): string | undefined {
  const v = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[\da-f]{6}$/.test(v)) return `#${v}`;
  if (/^[\da-f]{3}$/.test(v)) return `#${v.replace(/./g, '$&$&')}`;
  return undefined;
}

/** A pseudo-random preset for a new label (as the classic form starts with one), by the labels there are. */
export function nextPreset(count: number): string {
  return LABEL_PRESETS[count % LABEL_PRESETS.length] ?? LABEL_PRESETS[0] ?? '';
}

/** What a label's form holds. */
export interface LabelDraft {
  name: string;
  description: string;
  color: string;
  exclusive: boolean;
  archived: boolean;
}

/** Forgejo's limits (the classic form and models/issues: a name of 50 characters, a description of 200). */
export const NAME_MAX = 50;
export const DESCRIPTION_MAX = 200;

export interface LabelProblems {
  name?: string;
  color?: string;
  description?: string;
  /** Not a problem: "exclusive" asks for a scope (`scope/name`). */
  exclusive?: string;
}

/** What is wrong with a draft (empty: it can be saved). */
export function labelProblems(d: LabelDraft): LabelProblems {
  const out: LabelProblems = {};
  const name = d.name.trim();
  if (!name) out.name = 'A label needs a name.';
  else if (name.length > NAME_MAX) out.name = `At most ${String(NAME_MAX)} characters.`;
  if (d.description.length > DESCRIPTION_MAX) out.description = `At most ${String(DESCRIPTION_MAX)} characters.`;
  if (!normalizeColor(d.color)) out.color = 'A colour as #rrggbb.';
  if (d.exclusive && !exclusiveScope({name, exclusive: true})) out.exclusive = 'Exclusive labels need a scope: name it “scope/name”.';
  return out;
}

/** Whether a draft can be saved. */
export function labelValid(d: LabelDraft): boolean {
  const p = labelProblems(d);
  return !p.name && !p.color && !p.description;
}

/** The draft of an existing label (its form, filled). */
export function draftOf(l: Label): LabelDraft {
  return {name: l.name, description: l.description, color: normalizeColor(l.color) ?? l.color, exclusive: l.exclusive, archived: Boolean(l.archived_at)};
}

/** The fields of API v1's EditLabelOption that differ from the label (undefined: nothing changed). */
export function labelEdit(l: Label, d: LabelDraft): Record<string, string | boolean> | undefined {
  const out: Record<string, string | boolean> = {};
  const name = d.name.trim();
  const color = normalizeColor(d.color) ?? d.color;
  if (name !== l.name) out.name = name;
  if (d.description !== l.description) out.description = d.description;
  if (color !== (normalizeColor(l.color) ?? l.color)) out.color = color;
  if (d.exclusive !== l.exclusive) out.exclusive = d.exclusive;
  if (d.archived !== Boolean(l.archived_at)) out.is_archived = d.archived;
  return Object.keys(out).length ? out : undefined;
}
