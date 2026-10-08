// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// `vite preview` (the boot tests) stands in for Forgejo's SPA serving (B8):
// documents get the server's config block, with an OAuth client that points
// at this origin, so the build boots exactly as it does behind Forgejo.
// Forgejo itself inserts the real block; this plugin does nothing else.

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';
import {type NextConfig, NextConfigElementID, ProtocolVersion} from '../src/protocol/types.gen.ts';

export function previewConfig(): Plugin {
  return {
    name: 'next:preview-config',
    configurePreviewServer(server) {
      const base = server.config.base;
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const doc = path.startsWith(base) && !/\.[a-z0-9]+$/i.test(path);
        if (!doc || req.method !== 'GET') {
          next();
          return;
        }
        const origin = `http://${req.headers.host ?? 'localhost'}`;
        const config: NextConfig = {
          app_url: `${origin}/`, app_sub_url: '', base, app_name: 'Forgejo', version: 'preview', protocol: ProtocolVersion,
          oauth: {
            client_id: 'preview', redirect_uri: `${origin}${base}callback`, scope: 'write:issue write:repository read:user read:organization write:notification',
            authorize_url: '/login/oauth/authorize', token_url: '/login/oauth/access_token',
          },
        };
        const html = readFileSync(resolve(outDir, 'index.html'), 'utf8').replace('<meta charset="utf-8">',
          `<meta charset="utf-8">\n<script type="application/json" id="${NextConfigElementID}">${JSON.stringify(config)}</script>`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(html);
      });
    },
  };
}
