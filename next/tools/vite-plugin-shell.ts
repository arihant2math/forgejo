// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Inline splash, static boot HTML and app CSS for first paint; preload boot-route chunks before CSS parsing.

import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {type ComponentType, createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer, minifySync, type Plugin, type ViteDevServer} from 'vite';
import type {OutputAsset, OutputBundle, OutputChunk} from 'rolldown';
import {applySplash} from '../src/app/splash.ts';

export interface ShellOptions {
  /** Modules (relative to the project root) whose chunks the boot route needs. */
  bootRoutes: string[];
}

export function splashScript(): string {
  const {code, errors} = minifySync('splash.js', `(${applySplash.toString()})(window)`);
  if (errors.length) throw new Error(`minifying the splash script: ${errors.map((e) => e.message).join('; ')}`);
  return code.trim();
}

export function staticClosure(bundle: OutputBundle, start: OutputChunk): OutputChunk[] {
  const seen = new Map<string, OutputChunk>();
  const visit = (chunk: OutputChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.set(chunk.fileName, chunk);
    for (const name of chunk.imports) {
      const dep = bundle[name];
      if (dep?.type === 'chunk') visit(dep);
    }
  };
  visit(start);
  return [...seen.values()];
}

/** The `@layer theme{…}` blocks of a stylesheet, as [start, end) offsets of their bodies. */
function themeBlocks(css: string): [number, number][] {
  const blocks: [number, number][] = [];
  for (let i = css.indexOf('@layer theme{'); i >= 0; i = css.indexOf('@layer theme{', i + 1)) {
    const start = i + '@layer theme{'.length;
    let depth = 1;
    let j = start;
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    blocks.push([start, j - 1]);
  }
  return blocks;
}

/**
 * Drops custom properties of the `theme` layer (Primer's primitives, tokens.css) that nothing reads: no other CSS,
 * no emitted JS (`elsewhere`), no kept property's value. Names JS builds at runtime (`--spacing-${gap}`) keep
 * every property with that prefix.
 */
export function pruneThemeTokens(css: string, elsewhere: string): string {
  const blocks = themeBlocks(css);
  if (!blocks.length) return css;
  let outside = elsewhere;
  let last = 0;
  for (const [a, b] of blocks) {
    outside += css.slice(last, a);
    last = b;
  }
  outside += css.slice(last);
  const decl = /(--[\w-]+):[^;{}]*(?:;|(?=\}))/g;
  const values = new Map<string, string[]>();
  for (const [a, b] of blocks) {
    for (const m of css.slice(a, b).matchAll(decl)) values.set(m[1] ?? '', [...values.get(m[1] ?? '') ?? [], m[0]]);
  }
  const prefixes = [...outside.matchAll(/(--[\w-]*?-?)(?:\$\{|["'`]\s*\+)/g)].map((m) => m[1] ?? '').filter((p) => p.length > 2);
  const used = new Set<string>();
  const queue = [...outside.matchAll(/--[\w-]+/g)].map((m) => m[0]);
  for (const name of values.keys()) if (prefixes.some((p) => name.startsWith(p))) queue.push(name);
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (used.has(name) || !values.has(name)) continue;
    used.add(name);
    for (const d of values.get(name) ?? []) for (const m of d.slice(name.length + 1).matchAll(/--[\w-]+/g)) queue.push(m[0]);
  }
  let out = '';
  last = 0;
  for (const [a, b] of blocks) {
    const body = css.slice(a, b).replace(decl, (d, name: string) => (used.has(name) ? d : ''))
      .replace(/;(?=\})/g, '').replace(/[^{};]+\{\}/g, '');
    out += css.slice(last, a) + body;
    last = b;
  }
  return out + css.slice(last);
}

/** Vite's SSR loader handles Primer's CSS imports, which Node cannot load. */
async function loadBootShell(root: string, server: ViteDevServer | undefined): Promise<ComponentType> {
  const load = async (s: ViteDevServer) => (await s.ssrLoadModule('/src/app/BootShell.tsx') as {BootShell: ComponentType}).BootShell;
  if (server) return load(server);
  const tmp = await createServer({
    root, configFile: false, logLevel: 'silent', appType: 'custom',
    server: {middlewareMode: true, hmr: false, ws: false},
    ssr: {noExternal: [/@primer\/react/]},
  });
  try {
    return await load(tmp);
  } finally {
    await tmp.close();
  }
}

export function shell({bootRoutes}: ShellOptions): Plugin {
  let server: ViteDevServer | undefined;
  let base = '/';
  let root = '';
  let outDir = '';
  const inlined = new Set<string>();
  return {
    name: 'next:shell',
    configResolved(config) {
      base = config.base;
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(s) {
      server = s;
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        const BootShell = await loadBootShell(root, server);
        return html
          .replace('<!--next:splash-->', () => `<script>${splashScript()}</script>`)
          .replace('<!--next:boot-shell-->', () => renderToStaticMarkup(createElement(BootShell)));
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset') return;
        let html = String(page.source);

        // Keep the shared Primer component sheet linked and cached; inline only app styles.
        html = html.replace(/<link rel="stylesheet"[^>]*? href="([^"]+)"[^>]*>/g, (tag, href: string) => {
          const fileName = href.slice(base.length);
          if (/^assets\/vendor-primer-react-[\w-]+\.css$/.test(fileName)) return tag;
          const css = bundle[fileName] as OutputAsset | undefined;
          if (css?.type !== 'asset') return tag;
          delete bundle[fileName]; // eslint-disable-line @typescript-eslint/no-dynamic-delete -- the bundle is a plain record
          inlined.add(fileName);
          return `<style>${String(css.source).trim()}</style>`;
        });
        const elsewhere = [html.replace(/<style>[\s\S]*?<\/style>/g, ''), ...Object.values(bundle).map((f) => (f.type === 'chunk' ? f.code : f.fileName.endsWith('.map') ? '' : String(f.source)))].join('\n');
        html = html.replace(/<style>([\s\S]*?)<\/style>/g, (_tag, css: string) => `<style>${pruneThemeTokens(css, elsewhere)}</style>`);

        const preloaded = new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]));
        const links: string[] = [];
        for (const route of bootRoutes) {
          const id = `${root}/${route}`;
          const chunk = Object.values(bundle).find((c): c is OutputChunk => c.type === 'chunk' && c.facadeModuleId === id);
          if (!chunk) throw new Error(`next:shell: boot route ${route} has no chunk of its own`);
          for (const dep of staticClosure(bundle, chunk)) {
            const href = base + dep.fileName;
            if (preloaded.has(href)) continue;
            preloaded.add(href);
            links.push(`<link rel="modulepreload" crossorigin href="${href}">`);
          }
        }
        // Replace lazy preload references to inlined CSS with the loaded entry chunk, preserving dependency indexes.
        const entryChunk = Object.values(bundle).find((c): c is OutputChunk => c.type === 'chunk' && c.isEntry);
        if (entryChunk) {
          for (const c of Object.values(bundle)) {
            if (c.type !== 'chunk') continue;
            for (const f of inlined) c.code = c.code.replaceAll(JSON.stringify(f), JSON.stringify(entryChunk.fileName));
          }
        }
        const entry = /<script type="module"[^>]*><\/script>/.exec(html);
        if (!entry) throw new Error('next:shell: no entry <script type="module"> in index.html');
        html = html.replace(entry[0], `${entry[0]}${links.join('')}`);
        page.source = html;
      },
    },
    writeBundle() {
      // Manifest consumers must not request the removed, inlined stylesheet.
      if (!inlined.size) return;
      const path = join(outDir, '.vite/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, {css?: string[]}>;
      for (const chunk of Object.values(manifest)) {
        if (!chunk.css) continue;
        chunk.css = chunk.css.filter((f) => !inlined.has(f));
        if (!chunk.css.length) delete chunk.css;
      }
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
