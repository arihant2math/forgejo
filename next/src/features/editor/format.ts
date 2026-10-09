// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown formatting by key (⌘B, ⌘I, ⌘K) and the editor's toolbar: the selection wrapped in the syntax (or the
// syntax around it taken away again), as one change. Pure.

export type Format = 'bold' | 'italic' | 'link';

export interface Edit {
  /** The range of the document replaced, and what replaces it. */
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards (document positions after the change). */
  anchor: number;
  head: number;
}

const MARK: Record<Exclude<Format, 'link'>, string> = {bold: '**', italic: '_'};

/** The edit that formats the selection [from, to) of `doc`. */
export function formatEdit(doc: string, from: number, to: number, kind: Format): Edit {
  const sel = doc.slice(from, to);
  if (kind === 'link') {
    // [text](url): the URL selected to type over (the text when there was none).
    const text = sel || 'text';
    const insert = `[${text}](url)`;
    const urlAt = from + text.length + 3;
    return sel ? {from, to, insert, anchor: urlAt, head: urlAt + 3} : {from, to, insert, anchor: from + 1, head: from + 1 + text.length};
  }
  const m = MARK[kind];
  // Already formatted (the marks right around the selection): unformat.
  if (doc.slice(from - m.length, from) === m && doc.slice(to, to + m.length) === m) {
    return {from: from - m.length, to: to + m.length, insert: sel, anchor: from - m.length, head: to - m.length};
  }
  return {from, to, insert: `${m}${sel}${m}`, anchor: from + m.length, head: to + m.length};
}
