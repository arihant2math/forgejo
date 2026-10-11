// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown formatting by key (⌘B, ⌘I, ⌘E) and the editor's toolbar: the selection wrapped in the syntax (or the
// syntax around it taken away again), as one change. Pure.

export type Format = 'bold' | 'italic' | 'link' | 'code';

export interface Edit {
  /** The range of the document replaced, and what replaces it. */
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards (document positions after the change). */
  anchor: number;
  head: number;
}

/** An edit made from the document and the selection [from, to) (a toolbar tool's: see MarkdownField `tools`). */
export type EditMaker = (doc: string, from: number, to: number) => Edit;

const MARK: Record<Exclude<Format, 'link' | 'code'>, string> = {bold: '**', italic: '_'};

/** The longest run of backticks in `text`. */
function longestTicks(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
}

/**
 * Code: a selection within one line becomes inline code; several lines, or nothing selected (a place to paste a log
 * or a stack trace), a fenced block on lines of its own. Either is taken away again when the selection is already
 * exactly its content.
 */
function codeEdit(doc: string, from: number, to: number): Edit {
  const sel = doc.slice(from, to);
  // Already a fenced block around exactly the selection (the fence lines right before and after it): unfence.
  if (sel && doc[from - 1] === '\n') {
    const start = doc.lastIndexOf('\n', from - 2) + 1;
    const fence = /^(`{3,})[^`]*$/.exec(doc.slice(start, from - 1))?.[1];
    const lineEnd = doc.indexOf('\n', to + 1);
    if (fence && doc[to] === '\n' && doc.slice(to + 1, lineEnd < 0 ? doc.length : lineEnd) === fence) {
      return {from: start, to: to + 1 + fence.length, insert: sel, anchor: start, head: start + sel.length};
    }
  }
  if (sel && !sel.includes('\n')) {
    // Already inline code: unwrap.
    if (doc[from - 1] === '`' && doc[to] === '`' && !sel.includes('`')) {
      return {from: from - 1, to: to + 1, insert: sel, anchor: from - 1, head: to - 1};
    }
    // Backticks inside take a longer run around them (CommonMark), with spaces when the code starts or ends with one.
    const ticks = '`'.repeat(longestTicks(sel) + 1);
    const pad = sel.startsWith('`') || sel.endsWith('`') ? ' ' : '';
    const before = `${ticks}${pad}`;
    return {from, to, insert: `${before}${sel}${pad}${ticks}`, anchor: from + before.length, head: from + before.length + sel.length};
  }
  // A fence longer than any backtick run in the code, on lines of its own.
  const fence = '`'.repeat(Math.max(3, longestTicks(sel) + 1));
  const lead = from > 0 && doc[from - 1] !== '\n' ? '\n' : '';
  const body = sel.endsWith('\n') ? sel.slice(0, -1) : sel;
  const kept = sel.length - body.length;
  const trail = to < doc.length && doc[to] !== '\n' && !kept ? '\n' : '';
  const insert = `${lead}${fence}\n${body}\n${fence}${kept ? '\n' : ''}${trail}`;
  const at = from + lead.length + fence.length + 1;
  return {from, to, insert, anchor: at, head: at + body.length};
}

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
  if (kind === 'code') return codeEdit(doc, from, to);
  const m = MARK[kind];
  // Already formatted (the marks right around the selection): unformat.
  if (doc.slice(from - m.length, from) === m && doc.slice(to, to + m.length) === m) {
    return {from: from - m.length, to: to + m.length, insert: sel, anchor: from - m.length, head: to - m.length};
  }
  return {from, to, insert: `${m}${sel}${m}`, anchor: from + m.length, head: to + m.length};
}
