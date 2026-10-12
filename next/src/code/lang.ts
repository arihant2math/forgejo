// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Curate lazy grammar chunks to avoid shipping Shiki's hundreds of grammars.

/** Character limit checked before sending text to the worker. */
export const HIGHLIGHT_MAX_CHARS = 1_000_000;

export const LANGS = [
  'javascript', 'jsx', 'typescript', 'tsx', 'json', 'jsonc', 'go', 'python', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'php',
  'ruby', 'shellscript', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'less', 'markdown', 'sql', 'docker', 'make', 'lua',
  'swift', 'dart', 'diff', 'vue', 'svelte', 'graphql', 'nix', 'elixir', 'erlang', 'haskell', 'scala', 'perl', 'r', 'zig', 'proto',
  'hcl', 'groovy', 'powershell', 'objective-c', 'ocaml', 'clojure', 'fsharp', 'nginx', 'cmake', 'latex', 'bat', 'properties',
] as const;

export type Lang = typeof LANGS[number];

const EXT: Record<string, Lang> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', json5: 'jsonc', go: 'go', py: 'python', pyi: 'python', rs: 'rust', java: 'java', kt: 'kotlin',
  kts: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'csharp', php: 'php',
  rb: 'ruby', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  cfg: 'ini', conf: 'ini', editorconfig: 'ini', xml: 'xml', svg: 'xml', html: 'html', htm: 'html', tmpl: 'html', css: 'css',
  scss: 'scss', less: 'less', md: 'markdown', markdown: 'markdown', sql: 'sql', mk: 'make', lua: 'lua', swift: 'swift', dart: 'dart',
  diff: 'diff', patch: 'diff', vue: 'vue', svelte: 'svelte', graphql: 'graphql', gql: 'graphql', nix: 'nix', ex: 'elixir',
  exs: 'elixir', erl: 'erlang', hrl: 'erlang', hs: 'haskell', scala: 'scala', sc: 'scala', pl: 'perl', pm: 'perl', r: 'r', zig: 'zig',
  proto: 'proto', tf: 'hcl', hcl: 'hcl', groovy: 'groovy', gradle: 'groovy', ps1: 'powershell', m: 'objective-c', ml: 'ocaml',
  mli: 'ocaml', clj: 'clojure', cljs: 'clojure', edn: 'clojure', fs: 'fsharp', fsx: 'fsharp', cmake: 'cmake', tex: 'latex',
  bat: 'bat', cmd: 'bat', properties: 'properties',
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
  return dot < 0 ? undefined : EXT[name.slice(dot + 1)];
}
