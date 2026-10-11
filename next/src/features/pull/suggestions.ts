// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface Suggestion {start: number; end: number; text: string}
export function suggestionOf(body: string, line: number): Suggestion | undefined {
  const m = /```suggestion(?: -(\d+)\+([0-9]+))?\r?\n([\s\S]*?)\r?\n```/.exec(body);
  if (!m || line < 1) return undefined;
  return {start: line - Number(m[1] ?? 0), end: line + Number(m[2] ?? 0), text: m[3] ?? ''};
}
export function replaceSuggestions(text: string, edits: (Suggestion & {original: string})[]): string {
  const lines = text.split('\n');
  let previous = lines.length + 1;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    if (e.start < 1 || e.end >= previous || lines.slice(e.start - 1, e.end).join('\n') !== e.original) throw new Error('Suggestion is stale or overlaps another suggestion.');
    lines.splice(e.start - 1, e.end - e.start + 1, ...(e.text ? e.text.split('\n') : []));
    previous = e.start;
  }
  return lines.join('\n');
}
