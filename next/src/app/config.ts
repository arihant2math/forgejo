// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server's configuration (B8, protocol.NextConfig): a JSON data block
// <script type="application/json" id="forgejo-next-config"> that Forgejo
// inserts into index.html, or GET {base}config on a dev server.
//
// URLs are always built from `app_sub_url` / `base` (B8 rewrites only exact
// "/-/next/" literals of the build when Forgejo runs under a sub-path):
// never concatenate "/-/next" with something.

import {type NextConfig, NextConfigElementID, ProtocolVersion} from '../protocol/types.gen.ts';

/** The configuration when the document has none (vite preview, tests): no sign-in. */
export function fallbackConfig(): NextConfig {
  const base = import.meta.env.BASE_URL;
  const appSubUrl = base.replace(/\/-\/next\/$/, '');
  return {
    app_url: `${location.origin}${appSubUrl}/`, app_sub_url: appSubUrl, base, app_name: 'Forgejo', version: '',
    protocol: ProtocolVersion, oauth: null,
  };
}

function valid(c: unknown): c is NextConfig {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.app_sub_url === 'string' && typeof o.base === 'string' && typeof o.app_url === 'string' &&
    o.base.startsWith(o.app_sub_url) && (o.oauth === null || typeof o.oauth === 'object');
}

/** Reads the config block of the document; undefined when there is none (or it is broken). */
export function readConfigBlock(doc: Document = document): NextConfig | undefined {
  const el = doc.getElementById(NextConfigElementID);
  if (el?.getAttribute('type') !== 'application/json') return undefined;
  try {
    const c: unknown = JSON.parse(el.textContent);
    return valid(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The configuration. A dev server has no config block: it asks
 * GET {base}config (Vite proxies it to NEXT_FORGEJO_URL, see vite.config.ts).
 */
export async function loadConfig(): Promise<NextConfig> {
  const block = readConfigBlock();
  if (block) return block;
  if (import.meta.env.DEV) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}config`, {cache: 'no-store'});
      if (res.ok) {
        const c: unknown = await res.json();
        if (valid(c)) return c;
      }
    } catch {
      // No Forgejo behind the dev server.
    }
  }
  return fallbackConfig();
}

/** A path on the Forgejo instance (`path` starts with "/"), sub-path included. */
export function sitePath(config: NextConfig, path: string): string {
  return `${config.app_sub_url}${path}`;
}

/** The UI's own pages below the base (`name` has no leading "/"), e.g. uiPath(c, 'callback'). */
export function uiPath(config: NextConfig, name: string): string {
  return `${config.base}${name}`;
}

/**
 * The OAuth2 redirect URI. The server's (AppURL-based) one when this page is
 * served from that origin; otherwise this origin's callback, which works for
 * the http loopback dev URIs B8 registers with [livesync] OAUTH_REDIRECT_URIS.
 */
export function redirectUri(config: NextConfig): string | undefined {
  const o = config.oauth;
  if (!o) return undefined;
  try {
    if (new URL(o.redirect_uri).origin === location.origin) return o.redirect_uri;
  } catch {
    return undefined;
  }
  return new URL(uiPath(config, 'callback'), location.origin).href;
}

/**
 * Whether `path` is a same-site path below the app's sub-path that is safe to
 * return to after sign-in (no scheme, no "//" host, no backslashes).
 */
export function isLocalPath(config: NextConfig, path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  try {
    const u = new URL(path, 'http://x');
    if (u.host !== 'x') return false;
  } catch {
    return false;
  }
  return path === config.app_sub_url || path.startsWith(`${config.app_sub_url}/`);
}
