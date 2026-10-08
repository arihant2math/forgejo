// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Builds the service worker (src/sw/sw.ts) into dist/sw.js — one classic
// script, not hashed (B8 serves it at {base}sw.js, revalidated on every
// load) — with this build's version and the list of its hashed assets
// (precached at install), and marks index.html with the same version
// (<meta name="forgejo-next-build">) so the worker caches only its own
// build's shell. NEXT_SW_KILL=1 builds a worker that unregisters itself.
//
// The version is a hash of index.html and the asset names (themselves
// content hashes): any change of the app is a new version.

import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {rolldown} from 'rolldown';
import type {Plugin} from 'vite';
import {BUILD_META} from '../src/sw/routes.ts';

export function serviceWorker(): Plugin {
  let base = '/';
  let root = '';
  let build = false;
  return {
    name: 'next:sw',
    configResolved(config) {
      base = config.base;
      root = config.root;
      build = config.command === 'build';
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        if (!build) return;
        const page = bundle['index.html'];
        if (page?.type !== 'asset') return;
        const assets = Object.keys(bundle).filter((f) => f.startsWith('assets/') && !f.endsWith('.map')).sort();
        const html = String(page.source);
        const version = createHash('sha256').update(html).update(assets.join('\n')).digest('hex').slice(0, 16);
        const marked = html.replace(/<meta charset="UTF-8">/i, (m) => `${m}<meta name="${BUILD_META}" content="${version}">`);
        if (marked === html) throw new Error('next:sw: no <meta charset> in index.html to put the build version after');
        page.source = marked;
        const kill = process.env.NEXT_SW_KILL === '1';
        const worker = await rolldown({
          input: resolve(root, 'src/sw/sw.ts'),
          transform: {define: {__NEXT_BUILD__: JSON.stringify({version, base, assets, kill})}},
          platform: 'browser',
        });
        const {output} = await worker.generate({format: 'iife', minify: true});
        await worker.close();
        const [chunk] = output;
        // B8 rewrites string literals that are exactly the base under a sub-path (routers/livesync/spa.go
        // rewriteBase): the worker must keep one, or it would use /-/next/ under every sub-path.
        if (![`"${base}"`, `'${base}'`, `\`${base}\``].some((lit) => chunk.code.includes(lit))) {
          throw new Error(`next:sw: the built sw.js has no literal ${base} for B8 to rewrite under a sub-path`);
        }
        this.emitFile({type: 'asset', fileName: 'sw.js', source: chunk.code});
      },
    },
  };
}
