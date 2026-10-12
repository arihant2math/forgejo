// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Configuration comes from Forgejo's JSON data block, or GET {base}config in development.
// Build URLs from app_sub_url/base; literal "/-/next/" rewriting does not cover concatenated paths.

import {type NextConfig, NextConfigElementID, ProtocolVersion} from '../protocol/types.gen.ts';

/** The configuration when the document has none (vite preview, tests): no sign-in. */
export function fallbackConfig(): NextConfig {
  const base = import.meta.env.BASE_URL;
  const appSubUrl = base.replace(/\/-\/next\/$/, '');
  return {
    app_url: `${location.origin}${appSubUrl}/`, app_sub_url: appSubUrl, base, app_name: 'Forgejo', version: '',
    protocol: ProtocolVersion, oauth: null, wip_prefixes: ['WIP:', '[WIP]'],
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

/** In development, fetches GET {base}config through Vite's Forgejo proxy. */
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

/** Uses this origin's callback in development, where loopback redirect URIs are registered. */
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
