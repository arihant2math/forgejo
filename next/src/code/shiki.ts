// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one Shiki configuration: the curated grammars (each its own lazy chunk), how fence names and paths resolve to
// them, the theme and the input limits. Colours are Primer's prettylights syntax tokens, so they follow every colour
// mode, and stored highlights are class codes independent of the mode.

import type {LanguageRegistration, ThemeRegistration} from '@shikijs/core';

export const LANGS = [
  'javascript', 'jsx', 'typescript', 'tsx', 'json', 'jsonc', 'go', 'python', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'php',
  'ruby', 'shellscript', 'shellsession', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'less', 'markdown', 'sql', 'docker',
  'make', 'lua', 'swift', 'dart', 'diff', 'vue', 'svelte', 'graphql', 'nix', 'elixir', 'erlang', 'haskell', 'scala', 'perl', 'r',
  'zig', 'proto', 'hcl', 'groovy', 'powershell', 'objective-c', 'ocaml', 'clojure', 'fsharp', 'nginx', 'cmake', 'latex', 'bat',
] as const;

export type Lang = typeof LANGS[number];

type Loader = () => Promise<{default: LanguageRegistration[]}>;

/** Static imports, so that each grammar becomes its own lazy chunk. */
export const GRAMMARS: Record<Lang, Loader> = {
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
  'shellsession': () => import('@shikijs/langs/shellsession'),
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
};

/**
 * Shiki's own aliases of the grammars above, as their registrations declare them (shiki.test.ts keeps the two
 * equal), so that fences name languages the way Shiki does. The grammars' registrations load lazily, hence the copy.
 */
export const ALIASES: Readonly<Record<string, Lang>> = {
  'js': 'javascript', 'cjs': 'javascript', 'mjs': 'javascript', 'ts': 'typescript', 'cts': 'typescript', 'mts': 'typescript',
  'py': 'python', 'rs': 'rust', 'kt': 'kotlin', 'kts': 'kotlin', 'c++': 'cpp', 'c#': 'csharp', 'cs': 'csharp', 'rb': 'ruby',
  'bash': 'shellscript', 'sh': 'shellscript', 'shell': 'shellscript', 'zsh': 'shellscript', 'console': 'shellsession',
  'yml': 'yaml', 'properties': 'ini', 'md': 'markdown', 'dockerfile': 'docker', 'makefile': 'make', 'gql': 'graphql',
  'erl': 'erlang', 'hs': 'haskell', 'protobuf': 'proto', 'ps': 'powershell', 'ps1': 'powershell', 'pwsh': 'powershell',
  'objc': 'objective-c', 'clj': 'clojure', 'f#': 'fsharp', 'fs': 'fsharp', 'batch': 'bat', 'cmd': 'bat',
};

const IDS: ReadonlySet<string> = new Set(LANGS);

/** Fence names GitHub's linguist knows for these grammars that neither Shiki nor a file extension spells. */
const FENCES: Readonly<Record<string, Lang>> = {golang: 'go', terraform: 'hcl'};

/**
 * A language for a fence's info string (any case): a Shiki id or alias, else a file extension or one of linguist's
 * names, as GitHub highlights them; undefined is plain.
 */
export function langOfName(name: string): Lang | undefined {
  const n = name.trim().toLowerCase();
  return IDS.has(n) ? n as Lang : ALIASES[n] ?? EXT[n] ?? FENCES[n];
}

/** Extensions Shiki's ids and aliases do not cover; null keeps an alias that names another format plain. */
const EXT: Record<string, Lang | null> = {
  pyi: 'python', json5: 'jsonc', h: 'c', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cfg: 'ini', conf: 'ini',
  editorconfig: 'ini', svg: 'xml', htm: 'html', tmpl: 'html', markdown: 'markdown', mk: 'make', patch: 'diff', ex: 'elixir',
  exs: 'elixir', hrl: 'erlang', sc: 'scala', pl: 'perl', pm: 'perl', tf: 'hcl', gradle: 'groovy', m: 'objective-c', ml: 'ocaml',
  mli: 'ocaml', cljs: 'clojure', edn: 'clojure', fsx: 'fsharp', tex: 'latex', ps: null,
};

const NAMES: Record<string, Lang> = {
  'dockerfile': 'docker', 'containerfile': 'docker', 'makefile': 'make', 'gnumakefile': 'make', 'cmakelists.txt': 'cmake',
  'gemfile': 'ruby', 'rakefile': 'ruby', 'vagrantfile': 'ruby', 'go.mod': 'go', '.bashrc': 'shellscript', '.zshrc': 'shellscript',
  '.profile': 'shellscript', 'nginx.conf': 'nginx', 'jenkinsfile': 'groovy',
};

/** The grammar for a path, or undefined (plain text). */
export function langOf(path: string): Lang | undefined {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const byName = NAMES[name];
  if (byName) return byName;
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'docker';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1);
  const known = EXT[ext];
  return known === null ? undefined : known ?? langOfName(ext);
}

/** Input limits that bound tokenization time and memory. */
export const LIMITS = {
  /** Characters of one text (checked before it is sent to the worker). */
  chars: 1_000_000,
  lines: 40_000,
  /** Longer lines stay plain: crafted ones can make TextMate grammars backtrack. */
  lineLength: 400,
  /** Lines of one diff file. */
  diffLines: 20_000,
  /** Lines per tokenization step, after which the worker reports progress. */
  chunk: 200,
} as const;

/**
 * Syntax styles: [prettylights variable, utility classes]. A style's index is the low five bits of a class code. A
 * token's text and background colours always go together, as in GitHub's own stylesheet.
 */
export const SYNTAX: readonly (readonly [string, string])[] = [
  ['', ''],
  ['keyword', 'text-syntax-keyword'],
  ['string', 'text-syntax-string'],
  ['comment', 'text-syntax-comment'],
  ['entity', 'text-syntax-entity'],
  ['entity-tag', 'text-syntax-entity-tag'],
  ['constant', 'text-syntax-constant'],
  ['variable', 'text-syntax-variable'],
  ['storage-modifier-import', 'text-syntax-storage-modifier-import'],
  ['string-regexp', 'text-syntax-string-regexp'],
  ['markup-heading', 'text-syntax-markup-heading'],
  ['markup-list', 'text-syntax-markup-list'],
  ['markup-bold', 'text-syntax-markup-bold'],
  ['markup-italic', 'text-syntax-markup-italic'],
  ['markup-inserted-text', 'text-syntax-markup-inserted bg-syntax-markup-inserted'],
  ['markup-deleted-text', 'text-syntax-markup-deleted bg-syntax-markup-deleted'],
  ['markup-changed-text', 'text-syntax-markup-changed bg-syntax-markup-changed'],
  ['markup-ignored-text', 'text-syntax-markup-ignored bg-syntax-markup-ignored'],
  ['meta-diff-range', 'text-syntax-meta-diff-range'],
  ['invalid-illegal-text', 'text-syntax-invalid-illegal bg-syntax-invalid-illegal'],
  ['brackethighlighter-angle', 'text-syntax-brackethighlighter-angle'],
  ['brackethighlighter-unmatched', 'text-syntax-brackethighlighter-unmatched'],
  ['carriage-return-text', 'text-syntax-carriage-return bg-syntax-carriage-return'],
  ['constant-other-reference-link', 'text-syntax-constant-other-reference-link'],
];

const tokenVar = (token: string) => `var(--color-prettylights-syntax-${token})`;

/**
 * GitHub's TextMate scopes (those of Shiki's github-light theme) with the prettylights token each one stands for.
 * invalid.illegal takes prettylights' text and background colours, like github.com's .pl-ii, where github-light has
 * only a red foreground. The theme's colours are only those variables; the worker turns them back into class codes.
 */
const RULES: readonly (readonly [token: string, fontStyle: string, scopes: readonly string[]])[] = [
  ['comment', '', ['comment', 'punctuation.definition.comment', 'string.comment']],
  ['constant', '', ['constant', 'entity.name.constant', 'variable.other.constant', 'variable.other.enummember', 'variable.language']],
  ['entity', '', ['entity', 'entity.name']],
  ['storage-modifier-import', '', ['variable.parameter.function']],
  ['entity-tag', '', ['entity.name.tag']],
  ['keyword', '', ['keyword', 'storage', 'storage.type']],
  ['storage-modifier-import', '', ['storage.modifier.package', 'storage.modifier.import', 'storage.type.java']],
  ['string', '', ['string', 'punctuation.definition.string', 'string punctuation.section.embedded source']],
  ['constant', '', ['support', 'meta.property-name']],
  ['variable', '', ['variable']],
  ['storage-modifier-import', '', ['variable.other']],
  ['brackethighlighter-unmatched', 'italic', ['invalid.broken', 'invalid.deprecated', 'invalid.unimplemented']],
  ['invalid-illegal-text', 'italic', ['invalid.illegal']],
  ['carriage-return-text', 'italic underline', ['carriage-return']],
  ['brackethighlighter-unmatched', '', ['message.error']],
  ['constant', '', ['string variable']],
  ['string', '', ['source.regexp', 'string.regexp', 'string.regexp.character-class', 'string.regexp source.ruby.embedded', 'string.regexp string.regexp.arbitrary-repitition']],
  ['string-regexp', 'bold', ['string.regexp constant.character.escape']],
  ['constant', '', ['support.constant', 'support.variable', 'meta.module-reference']],
  ['markup-list', '', ['punctuation.definition.list.begin.markdown']],
  ['markup-heading', 'bold', ['markup.heading', 'markup.heading entity.name', 'meta.separator']],
  ['entity-tag', '', ['markup.quote']],
  ['markup-italic', 'italic', ['markup.italic']],
  ['markup-bold', 'bold', ['markup.bold']],
  ['', 'underline', ['markup.underline']],
  ['', 'strikethrough', ['markup.strikethrough']],
  ['constant', '', ['markup.inline.raw', 'meta.diff.header', 'meta.output']],
  ['markup-deleted-text', '', ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted']],
  ['markup-inserted-text', '', ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted']],
  ['markup-changed-text', '', ['markup.changed', 'punctuation.definition.changed']],
  ['markup-ignored-text', '', ['markup.ignored', 'markup.untracked']],
  ['meta-diff-range', 'bold', ['meta.diff.range']],
  ['brackethighlighter-angle', '', ['brackethighlighter.tag', 'brackethighlighter.curly', 'brackethighlighter.round', 'brackethighlighter.square', 'brackethighlighter.angle', 'brackethighlighter.quote']],
  ['brackethighlighter-unmatched', '', ['brackethighlighter.unmatched']],
  ['constant-other-reference-link', 'underline', ['constant.other.reference.link', 'string.other.link']],
];

export const THEME: ThemeRegistration = {
  name: 'forgejo-prettylights',
  type: 'light',
  fg: 'var(--fgColor-default)',
  bg: 'var(--bgColor-default)',
  settings: /* @__PURE__ */ RULES.map(([token, fontStyle, scope]) => ({
    scope: [...scope],
    settings: {
      ...(token ? {foreground: tokenVar(token)} : {}),
      ...(token.endsWith('-text') ? {background: tokenVar(`${token.slice(0, -'-text'.length)}-bg`)} : {}),
      ...(fontStyle ? {fontStyle} : {}),
    },
  })),
};

const STYLE = /* @__PURE__ */ new Map(/* @__PURE__ */ SYNTAX.map(([token], i) => [tokenVar(token), i]));

/** Shiki's FontStyle bits, above the style index in a class code. */
const FONT: readonly string[] = ['italic', 'font-semibold', 'underline', 'line-through'];
const FONT_SHIFT = 5;

/** A class code from a token's colour (a prettylights variable) and its Shiki font style bits. */
export function classCode(color: string | undefined, fontStyle: number): number {
  const style = color ? STYLE.get(color) ?? 0 : 0;
  return style | ((fontStyle > 0 ? fontStyle & 15 : 0) << FONT_SHIFT);
}

const classes = new Map<number, string>();

/** The utility classes of a class code ('' for plain text). */
export function synClass(code: number): string {
  let c = classes.get(code);
  if (c === undefined) {
    const font = code >> FONT_SHIFT;
    // Underline and strikethrough set the same property: strikethrough wins.
    const parts = [SYNTAX[code & 31]?.[1] ?? '', ...FONT.filter((_, bit) => font & (1 << bit) && !(bit === 2 && font & 8))];
    // A code this build does not know stays plain.
    c = font > 15 ? '' : parts.filter(Boolean).join(' ');
    classes.set(code, c);
  }
  return c;
}

/** Bumped whenever the theme or the class codes change: stored highlights are keyed by it. */
export const TOKEN_FORMAT = 2;
