// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The code worker (PLAN §5.1, §5.7; Comlink): syntax highlighting and diff
// parsing stay off the main thread. Started by the first code view
// (src/code/source.ts): files, and a diff's files one at a time as the page
// shows them (the page parses diffs itself: see source.ts).

import {expose, transfer} from 'comlink';
import {DEL, type DiffFile, filePath} from '../code/diff.ts';
import {type Lang, langOf} from '../code/lang.ts';
import {highlight, type Highlight} from './highlight.ts';

export type {Highlight} from './highlight.ts';

/** Above this many lines a diff file is shown plain. */
const MAX_FILE_LINES = 20_000;

function out(h: Highlight | null): Highlight | null {
  return h ? transfer(h, [h.spans.buffer, h.starts.buffer]) : null;
}

/** Highlights one side's lines of a diff file and maps them back to the file's line indexes. */
async function highlightFile(f: DiffFile): Promise<Highlight | null> {
  const lang = langOf(filePath(f));
  if (!lang || f.binary || f.lines.length > MAX_FILE_LINES) return null;
  const newLines: string[] = [];
  const oldLines: string[] = [];
  const at = new Uint32Array(f.lines.length);
  f.lines.forEach((l, i) => {
    if (l.k === DEL) {
      at[i] = oldLines.length;
      oldLines.push(l.t);
    } else {
      at[i] = newLines.length;
      newLines.push(l.t);
    }
  });
  const [n, o] = await Promise.all([
    newLines.length ? highlight(newLines.join('\n'), lang) : null,
    oldLines.length ? highlight(oldLines.join('\n'), lang) : null,
  ]);
  if (!n && !o) return null;
  const spans: number[] = [];
  const starts = new Uint32Array(f.lines.length + 1);
  f.lines.forEach((l, i) => {
    starts[i] = spans.length / 2;
    const h = l.k === DEL ? o : n;
    const j = at[i] ?? 0;
    if (!h) {
      spans.push(l.t.length, 0);
      return;
    }
    const from = h.starts[j] ?? 0;
    const to = h.starts[j + 1] ?? from;
    for (let k = from; k < to; k++) spans.push(h.spans[2 * k] ?? 0, h.spans[2 * k + 1] ?? 0);
  });
  starts[f.lines.length] = spans.length / 2;
  return {spans: Uint32Array.from(spans), starts};
}

// A highlight that runs away (a grammar backtracking on crafted text) is stopped by terminating
// the worker (src/code/source.ts).
const api = {
  /** Highlights a file's text (null: plain). */
  async highlight(text: string, lang: Lang | undefined): Promise<Highlight | null> {
    return out(await highlight(text, lang));
  },

  /** Highlights one file of a diff, per diff line (null: plain). */
  async highlightDiffFile(f: DiffFile): Promise<Highlight | null> {
    return out(await highlightFile(f));
  },
};

export type CodeWorkerApi = typeof api;

expose(api);
