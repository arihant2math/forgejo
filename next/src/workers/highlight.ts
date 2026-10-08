// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Syntax highlighting with Shiki (PLAN §5.1), in the code worker only.
//
//   * Shiki's core with the JavaScript regex engine: no WebAssembly (the
//     document's CSP has no 'wasm-unsafe-eval'), no eval.
//   * One theme, Shiki's CSS-variables theme: every token colour is a
//     `var(--shiki-…)` name, which is mapped to a small class index here
//     (SYN). The page renders the index as one of the design tokens'
//     `text-syn-*` utilities, so both app themes come from tokens.css and a
//     highlighted file is cached once, whatever the theme.
//   * Grammars load lazily, one chunk each (lang.ts lists them).
//   * The output is never HTML: per line, (length, class) pairs over the
//     line's own text, which the page renders as text nodes.

import {createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type LanguageRegistration} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
import {HIGHLIGHT_MAX_CHARS, type Lang} from '../code/lang.ts';

/** Token classes (the page's table in features/code/syntax.ts maps them to utilities). */
export const SYN = {plain: 0, keyword: 1, string: 2, comment: 3, function: 4, constant: 5, parameter: 6, punctuation: 7, link: 8} as const;

const VARS: Record<string, number> = {
  'token-keyword': SYN.keyword, 'token-string': SYN.string, 'token-string-expression': SYN.string, 'token-comment': SYN.comment,
  'token-function': SYN.function, 'token-constant': SYN.constant, 'token-parameter': SYN.parameter, 'token-punctuation': SYN.punctuation,
  'token-link': SYN.link,
};

/**
 * A highlighted text: line i's tokens are the pairs (length, class) at
 * spans[2k], spans[2k + 1] for k in [starts[i], starts[i + 1]). Lengths are
 * UTF-16 code units of the line's text; they add up to the line's length.
 */
export interface Highlight {
  spans: Uint32Array;
  starts: Uint32Array;
}

type Loader = () => Promise<{default: LanguageRegistration[]}>;

// One import per grammar: each is its own lazy chunk.
const LOADERS: Record<Lang, Loader> = {
  'javascript': () => import('@shikijs/langs/javascript'),
  'jsx': () => import('@shikijs/langs/jsx'),
  'typescript': () => import('@shikijs/langs/typescript'),
  'tsx': () => import('@shikijs/langs/tsx'),
  'json': () => import('@shikijs/langs/json'),
  'jsonc': () => import('@shikijs/langs/jsonc'),
  'go': () => import('@shikijs/langs/go'),
  'python': () => import('@shikijs/langs/python'),
  'rust': () => import('@shikijs/langs/rust'),
  'java': () => import('@shikijs/langs/java'),
  'kotlin': () => import('@shikijs/langs/kotlin'),
  'c': () => import('@shikijs/langs/c'),
  'cpp': () => import('@shikijs/langs/cpp'),
  'csharp': () => import('@shikijs/langs/csharp'),
  'php': () => import('@shikijs/langs/php'),
  'ruby': () => import('@shikijs/langs/ruby'),
  'shellscript': () => import('@shikijs/langs/shellscript'),
  'yaml': () => import('@shikijs/langs/yaml'),
  'toml': () => import('@shikijs/langs/toml'),
  'ini': () => import('@shikijs/langs/ini'),
  'xml': () => import('@shikijs/langs/xml'),
  'html': () => import('@shikijs/langs/html'),
  'css': () => import('@shikijs/langs/css'),
  'scss': () => import('@shikijs/langs/scss'),
  'less': () => import('@shikijs/langs/less'),
  'markdown': () => import('@shikijs/langs/markdown'),
  'sql': () => import('@shikijs/langs/sql'),
  'docker': () => import('@shikijs/langs/docker'),
  'make': () => import('@shikijs/langs/make'),
  'lua': () => import('@shikijs/langs/lua'),
  'swift': () => import('@shikijs/langs/swift'),
  'dart': () => import('@shikijs/langs/dart'),
  'diff': () => import('@shikijs/langs/diff'),
  'vue': () => import('@shikijs/langs/vue'),
  'svelte': () => import('@shikijs/langs/svelte'),
  'graphql': () => import('@shikijs/langs/graphql'),
  'nix': () => import('@shikijs/langs/nix'),
  'elixir': () => import('@shikijs/langs/elixir'),
  'erlang': () => import('@shikijs/langs/erlang'),
  'haskell': () => import('@shikijs/langs/haskell'),
  'scala': () => import('@shikijs/langs/scala'),
  'perl': () => import('@shikijs/langs/perl'),
  'r': () => import('@shikijs/langs/r'),
  'zig': () => import('@shikijs/langs/zig'),
  'proto': () => import('@shikijs/langs/proto'),
  'hcl': () => import('@shikijs/langs/hcl'),
  'groovy': () => import('@shikijs/langs/groovy'),
  'powershell': () => import('@shikijs/langs/powershell'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  'ocaml': () => import('@shikijs/langs/ocaml'),
  'clojure': () => import('@shikijs/langs/clojure'),
  'fsharp': () => import('@shikijs/langs/fsharp'),
  'nginx': () => import('@shikijs/langs/nginx'),
  'cmake': () => import('@shikijs/langs/cmake'),
  'latex': () => import('@shikijs/langs/latex'),
  'bat': () => import('@shikijs/langs/bat'),
  'properties': () => import('@shikijs/langs/properties'),
};

const THEME = 'forgejo';

/** Above these a text is shown plain (highlighting it would take seconds and memory for little use). */
export const MAX_CHARS = HIGHLIGHT_MAX_CHARS;
export const MAX_LINES = 40_000;
/**
 * Longer lines are left plain (minified files; and a TextMate grammar can
 * backtrack for seconds on a long crafted line — the page also stops a
 * highlight that runs too long: src/code/source.ts).
 */
const MAX_LINE = 400;

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<Lang, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [createCssVariablesTheme({name: THEME, variablePrefix: '--shiki-', fontStyle: false})],
    langs: [],
    engine: createJavaScriptRegexEngine({forgiving: true}),
  });
  return core;
}

/** Loads a grammar; a failed load (its chunk not reachable) rejects and is tried again next time. */
function loadLang(h: HighlighterCore, lang: Lang): Promise<void> {
  let p = loaded.get(lang);
  if (!p) {
    p = LOADERS[lang]().then((m) => h.loadLanguage(...m.default));
    p.catch(() => {
      loaded.delete(lang);
    });
    loaded.set(lang, p);
  }
  return p;
}

function classOf(color: string | undefined): number {
  if (!color) return SYN.plain;
  const m = /^var\(--shiki-([a-z-]+)/.exec(color);
  return (m?.[1] ? VARS[m[1]] : undefined) ?? SYN.plain;
}

/** Starts Shiki and loads a grammar (rejects when it does not load). */
export async function prepare(lang: Lang): Promise<void> {
  if (lang in LOADERS) await loadLang(await highlighter(), lang);
}

/** Highlights text (lines split on \n; a \r before it is part of the line). null: plain (unknown grammar, too big); rejects when the grammar does not load. */
export async function highlight(text: string, lang: Lang | undefined): Promise<Highlight | null> {
  if (!lang || !(lang in LOADERS) || text.length > MAX_CHARS) return null;
  let lineCount = 1;
  for (let i = text.indexOf('\n'); i >= 0 && lineCount <= MAX_LINES; i = text.indexOf('\n', i + 1)) lineCount++;
  if (lineCount > MAX_LINES) return null;
  const h = await highlighter();
  await loadLang(h, lang);
  const tokens = h.codeToTokensBase(text, {lang, theme: THEME, tokenizeMaxLineLength: MAX_LINE});
  return compact(tokens, text);
}

/** Packs Shiki's token lines, merging neighbours of the same class; lines Shiki skipped stay one plain span. */
export function compact(lines: {content: string; color?: string}[][], text: string): Highlight {
  const texts = text.split('\n');
  const starts = new Uint32Array(texts.length + 1);
  const spans: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    starts[i] = spans.length / 2;
    const want = texts[i]?.length ?? 0;
    let got = 0;
    for (const t of lines[i] ?? []) {
      const len = t.content.length;
      if (!len) continue;
      const cls = classOf(t.color);
      const last = spans.length - 1;
      if (spans.length / 2 > (starts[i] ?? 0) && spans[last] === cls) spans[last - 1] = (spans[last - 1] ?? 0) + len;
      else spans.push(len, cls);
      got += len;
    }
    // Whatever Shiki did not cover (a trailing \r, a skipped long line) stays plain, so lengths always add up.
    if (got < want) spans.push(want - got, SYN.plain);
  }
  starts[texts.length] = spans.length / 2;
  return {spans: Uint32Array.from(spans), starts};
}
