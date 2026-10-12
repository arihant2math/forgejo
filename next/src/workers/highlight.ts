// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Use Shiki's JS engine because the CSP forbids WASM and eval.
// Tokens become (length, class code) spans, never HTML.
// Carry grammar state between chunks and report progress to the page's watchdog.

import {createHighlighterCore, type GrammarState, type HighlighterCore} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
import {classCode, GRAMMARS, type Lang, LIMITS, THEME} from '../code/shiki.ts';

/**
 * A highlighted text: line i's tokens are the pairs (length, class code) at
 * spans[2k], spans[2k + 1] for k in [starts[i], starts[i + 1]). Lengths are
 * UTF-16 code units of the line's text; they add up to the line's length.
 */
export interface Highlight {
  spans: Uint32Array;
  starts: Uint32Array;
}

const THEME_NAME = THEME.name ?? '';

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<Lang, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({forgiving: true}),
  });
  return core;
}

/** Loads a grammar; a failed load (its chunk not reachable) rejects and is tried again next time. */
function loadLang(h: HighlighterCore, lang: Lang): Promise<void> {
  let p = loaded.get(lang);
  if (!p) {
    p = GRAMMARS[lang]().then((m) => h.loadLanguage(...m.default));
    p.catch(() => {
      loaded.delete(lang);
    });
    loaded.set(lang, p);
  }
  return p;
}

/** Starts Shiki and loads a grammar (rejects when it does not load). */
export async function prepare(lang: Lang): Promise<void> {
  if (lang in GRAMMARS) await loadLang(await highlighter(), lang);
}

/**
 * Highlights text (lines split on \n; a \r before it is part of the line). null: plain (unknown grammar, too big);
 * rejects when the grammar does not load. `progress` is called after each chunk of `chunk` lines.
 */
export async function highlight(text: string, lang: Lang | undefined, progress?: () => void, chunk: number = LIMITS.chunk): Promise<Highlight | null> {
  if (!lang || !(lang in GRAMMARS) || text.length > LIMITS.chars) return null;
  const lines = text.split('\n');
  if (lines.length > LIMITS.lines) return null;
  const h = await highlighter();
  await loadLang(h, lang);
  const starts = new Uint32Array(lines.length + 1);
  const spans: number[] = [];
  let state: GrammarState | undefined;
  for (let at = 0; at < lines.length; at += chunk) {
    const part = h.codeToTokensBase(lines.slice(at, at + chunk).join('\n'), {
      lang, theme: THEME_NAME, tokenizeMaxLineLength: LIMITS.lineLength, ...(state ? {grammarState: state} : {}),
    });
    state = h.getLastGrammarState(part);
    const end = Math.min(at + chunk, lines.length);
    for (let i = at; i < end; i++) {
      starts[i] = spans.length / 2;
      pack(spans, part[i - at] ?? [], lines[i]?.length ?? 0);
    }
    progress?.();
  }
  starts[lines.length] = spans.length / 2;
  return {spans: Uint32Array.from(spans), starts};
}

/** Appends one line's tokens, merging neighbours of the same class; what Shiki skipped (a trailing \r, a long line) stays plain. */
export function pack(spans: number[], tokens: readonly {content: string; color?: string; fontStyle?: number}[], length: number): void {
  const first = spans.length;
  let got = 0;
  for (const t of tokens) {
    const len = t.content.length;
    if (!len) continue;
    const cls = classCode(t.color, t.fontStyle ?? 0);
    const last = spans.length - 1;
    if (spans.length > first && spans[last] === cls) spans[last - 1] = (spans[last - 1] ?? 0) + len;
    else spans.push(len, cls);
    got += len;
  }
  if (got >= length) return;
  if (spans.length > first && spans.at(-1) === 0) spans[spans.length - 2] = (spans.at(-2) ?? 0) + length - got;
  else spans.push(length - got, 0);
}
