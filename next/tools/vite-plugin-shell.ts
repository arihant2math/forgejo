// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Builds the index.html shell (PLAN §5.2):
//  * <!--next:splash--> → the inline boot script (src/app/splash.ts applySplash):
//    performance.mark('appStart') and localStorage.splash → <html> before first paint;
//  * <!--next:boot-shell--> → src/app/BootShell.tsx rendered to static HTML;
//  * (build) the app stylesheet is inlined as <style>, so the first frame needs no
//    CSS request; the CSS file is dropped from the output and from the manifest;
//  * (build) <link rel=modulepreload> for the boot routes' chunks, right after the
//    entry script so they start before the inline CSS is parsed (Vite already
//    preloads the entry's static imports).

import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {minifySync, type Plugin} from 'vite';
import type {OutputAsset, OutputBundle, OutputChunk} from 'rolldown';
import {BootShell} from '../src/app/BootShell.tsx';
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

/** The static closure of a chunk: itself and everything it imports statically. */
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

export function shell({bootRoutes}: ShellOptions): Plugin {
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
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
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

        // Inline the stylesheet(s) Vite linked from the page.
        html = html.replace(/<link rel="stylesheet"[^>]*? href="([^"]+)"[^>]*>/g, (tag, href: string) => {
          const fileName = href.slice(base.length);
          const css = bundle[fileName] as OutputAsset | undefined;
          if (css?.type !== 'asset') return tag;
          delete bundle[fileName]; // eslint-disable-line @typescript-eslint/no-dynamic-delete -- the bundle is a plain record
          inlined.add(fileName);
          return `<style>${String(css.source).trim()}</style>`;
        });

        // Modulepreload the boot routes' chunks.
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
        const entry = /<script type="module"[^>]*><\/script>/.exec(html);
        if (!entry) throw new Error('next:shell: no entry <script type="module"> in index.html');
        html = html.replace(entry[0], `${entry[0]}${links.join('')}`);
        page.source = html;
      },
    },
    writeBundle() {
      // The manifest still lists the inlined stylesheet; B8 and the service
      // worker read it, so drop the file that no longer exists.
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
