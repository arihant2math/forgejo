// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


export type Format = 'bold' | 'italic' | 'link' | 'code';

export interface Edit {
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards (document positions after the change). */
  anchor: number;
  head: number;
}

/** Document selection is [from, to). */
export type EditMaker = (doc: string, from: number, to: number) => Edit;

const MARK: Record<Exclude<Format, 'link' | 'code'>, string> = {bold: '**', italic: '_'};

function longestTicks(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
}

/** Single-line selections use inline code; multiline or empty selections use fences. */
function codeEdit(doc: string, from: number, to: number): Edit {
  const sel = doc.slice(from, to);
  if (sel && doc[from - 1] === '\n') {
    const start = doc.lastIndexOf('\n', from - 2) + 1;
    const fence = /^(`{3,})[^`]*$/.exec(doc.slice(start, from - 1))?.[1];
    const lineEnd = doc.indexOf('\n', to + 1);
    if (fence && doc[to] === '\n' && doc.slice(to + 1, lineEnd < 0 ? doc.length : lineEnd) === fence) {
      return {from: start, to: to + 1 + fence.length, insert: sel, anchor: start, head: start + sel.length};
    }
  }
  if (sel && !sel.includes('\n')) {
    if (doc[from - 1] === '`' && doc[to] === '`' && !sel.includes('`')) {
      return {from: from - 1, to: to + 1, insert: sel, anchor: from - 1, head: to - 1};
    }
    // CommonMark requires longer delimiters for embedded backticks and padding at their edges.
    const ticks = '`'.repeat(longestTicks(sel) + 1);
    const pad = sel.startsWith('`') || sel.endsWith('`') ? ' ' : '';
    const before = `${ticks}${pad}`;
    return {from, to, insert: `${before}${sel}${pad}${ticks}`, anchor: from + before.length, head: from + before.length + sel.length};
  }
  const fence = '`'.repeat(Math.max(3, longestTicks(sel) + 1));
  const lead = from > 0 && doc[from - 1] !== '\n' ? '\n' : '';
  const body = sel.endsWith('\n') ? sel.slice(0, -1) : sel;
  const kept = sel.length - body.length;
  const trail = to < doc.length && doc[to] !== '\n' && !kept ? '\n' : '';
  const insert = `${lead}${fence}\n${body}\n${fence}${kept ? '\n' : ''}${trail}`;
  const at = from + lead.length + fence.length + 1;
  return {from, to, insert, anchor: at, head: at + body.length};
}

/** Format document selection [from, to). */
export function formatEdit(doc: string, from: number, to: number, kind: Format): Edit {
  const sel = doc.slice(from, to);
  if (kind === 'link') {
    const text = sel || 'text';
    const insert = `[${text}](url)`;
    const urlAt = from + text.length + 3;
    return sel ? {from, to, insert, anchor: urlAt, head: urlAt + 3} : {from, to, insert, anchor: from + 1, head: from + 1 + text.length};
  }
  if (kind === 'code') return codeEdit(doc, from, to);
  const m = MARK[kind];
  if (doc.slice(from - m.length, from) === m && doc.slice(to, to + m.length) === m) {
    return {from: from - m.length, to: to + m.length, insert: sel, anchor: from - m.length, head: to - m.length};
  }
  return {from, to, insert: `${m}${sel}${m}`, anchor: from + m.length, head: to + m.length};
}
