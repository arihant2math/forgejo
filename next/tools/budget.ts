// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Bundle budgets (PLAN §5.8): the boot route may ship at most 150 KB of
// JavaScript and 30 KB of CSS, brotli-compressed. "Boot route" is everything
// dist/index.html executes or preloads: inline scripts, the entry module and
// every <link rel=modulepreload>; CSS is the inline <style> plus any linked
// stylesheet. It also checks that the whole static import graph of the entry
// and of the boot routes (tools/boot.ts) is preloaded, so no boot chunk is
// discovered late, that the inline CSS stays small enough to inline (beyond
// that, link a hashed stylesheet), and that the CSS contains nothing the lint
// rules ban (raw colours on non-token properties, transition: all).
//
// Usage: node tools/budget.ts [distDir]   (exit 1 when over budget)

import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {brotliCompressSync} from 'node:zlib';
import {BOOT_ROUTES} from './boot.ts';

export const BUDGET = {js: 150_000, css: 30_000, inlineCss: 10_000} as const;

export interface Item {
  name: string;
  kind: 'js' | 'css';
  raw: number;
  br: number;
}

export interface Report {
  items: Item[];
  js: number;
  css: number;
  problems: string[];
}

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

/** The attributes of every <tag …> in html, in any attribute order. */
function tags(html: string, name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => Object.fromEntries(
    [...(m[1] ?? '').matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map((a) => [(a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '']),
  ));
}

/** CSS the lint rules forbid that could still reach the output (e.g. from a dependency). */
export function cssProblems(css: string): string[] {
  const problems: string[] = [];
  // Custom properties are tokens; @property initial-values and #0000 (transparent) are Tailwind internals.
  for (const m of css.matchAll(/([\w-]+)\s*:\s*[^;{}]*?#(?!0000\b)[\da-f]{3,8}\b/gi)) {
    if (!m[1]?.startsWith('--') && m[1] !== 'initial-value') problems.push(`raw colour outside a token: ${m[0].slice(0, 80)}`);
  }
  for (const m of css.matchAll(/transition(?:-property)?\s*:\s*all\b[^;}]*/gi)) problems.push(`transition: all: ${m[0]}`);
  return problems;
}

const br = (s: string | Buffer) => brotliCompressSync(s).length;

export function analyze(dist: string, base = '/-/next/', bootRoutes: string[] = BOOT_ROUTES): Report {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const items: Item[] = [];
  const problems: string[] = [];
  const add = (name: string, kind: Item['kind'], content: string | Buffer) => {
    items.push({name, kind, raw: content.length, br: br(content)});
  };
  const fileOf = (url: string) => {
    if (!url.startsWith(base)) {
      problems.push(`${url}: not under base ${base}`);
      return undefined;
    }
    return url.slice(base.length);
  };

  let n = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(m[1] ?? '') && m[2]?.trim()) add(`index.html <script> #${++n}`, 'js', m[2]);
  }
  n = 0;
  let inlineCss = 0;
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    add(`index.html <style> #${++n}`, 'css', m[1] ?? '');
    inlineCss += br(m[1] ?? '');
    problems.push(...cssProblems(m[1] ?? ''));
  }
  if (inlineCss > BUDGET.inlineCss) {
    problems.push(`inline CSS ${inlineCss} B br > ${BUDGET.inlineCss} B: inline only tokens/base/shell and link the rest as a hashed stylesheet`);
  }

  const loaded = new Set<string>();
  const urls = [
    ...tags(html, 'script').map((a) => a.src),
    ...tags(html, 'link').filter((a) => /^(?:modulepreload|stylesheet)$/i.test(a.rel ?? '')).map((a) => a.href),
  ];
  for (const url of urls) {
    if (!url) continue;
    const file = fileOf(url);
    if (file === undefined || loaded.has(file)) continue;
    loaded.add(file);
    const path = join(dist, file);
    if (!existsSync(path)) {
      problems.push(`${file}: referenced by index.html but missing`);
      continue;
    }
    const content = readFileSync(path);
    add(file, file.endsWith('.css') ? 'css' : 'js', content);
    if (file.endsWith('.css')) problems.push(...cssProblems(content.toString()));
  }

  const manifestPath = join(dist, '.vite/manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestChunk>;
    const visit = (key: string, seen: Set<string>) => {
      const chunk = manifest[key];
      if (!chunk || seen.has(key)) return;
      seen.add(key);
      if (!loaded.has(chunk.file)) problems.push(`${chunk.file}: needed at boot but not preloaded`);
      for (const dep of chunk.imports ?? []) visit(dep, seen);
    };
    const seen = new Set<string>();
    for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key, seen);
    for (const route of bootRoutes) {
      if (!manifest[route]) problems.push(`boot route ${route}: no chunk of its own in the manifest`);
      visit(route, seen);
    }
  } else {
    problems.push('.vite/manifest.json missing (build.manifest must stay on)');
  }

  const sum = (kind: Item['kind']) => items.filter((i) => i.kind === kind).reduce((a, i) => a + i.br, 0);
  const report = {items, js: sum('js'), css: sum('css'), problems};
  if (report.js > BUDGET.js) problems.push(`boot JS ${report.js} B br > budget ${BUDGET.js} B`);
  if (report.css > BUDGET.css) problems.push(`boot CSS ${report.css} B br > budget ${BUDGET.css} B`);
  return report;
}

function format(r: Report): string {
  const kb = (b: number) => `${(b / 1000).toFixed(1)} KB`.padStart(9);
  const lines = r.items
    .toSorted((a, b) => b.br - a.br)
    .map((i) => `${i.kind.padEnd(4)}${kb(i.raw)} raw${kb(i.br)} br  ${i.name}`);
  lines.push(
    '',
    `boot JS  ${kb(r.js)} br of ${kb(BUDGET.js)}`,
    `boot CSS ${kb(r.css)} br of ${kb(BUDGET.css)} (inline at most ${kb(BUDGET.inlineCss)})`,
  );
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');
  const report = analyze(dist);
  console.log(format(report));
  if (report.problems.length) {
    console.error(`\nbudget check failed:\n  ${report.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nbudget check passed');
}
