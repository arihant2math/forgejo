// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Versioned shell and hashed assets are installed atomically; grammars cache on demand.
// Navigations try the network first, with cached-shell fallback for offline app routes.
// Activation removes other builds; retirement deletes caches and unregisters the worker.

import {AVATAR_CACHE, buildOf, CACHE_PREFIX, cacheName, isAvatarPath, isSpaRoute, sitePathOf, strategy} from './routes.ts';

interface Build {
  version: string;
  /** Deployment base URL, including the instance sub-path. */
  base: string;
  /** Asset paths below the base. */
  assets: string[];
  /** Assets cached on first use, excluded from install. */
  lazy: string[];
  kill: boolean;
}

declare const __NEXT_BUILD__: Build;

// Minimal service worker types (the DOM lib has none; the WebWorker lib would clash with it).
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith(r: Response | Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown;
  source: {postMessage(m: unknown): void} | null;
}
interface WorkerScope {
  registration: {
    scope: string;
    unregister(): Promise<boolean>;
    update(): Promise<unknown>;
    navigationPreload?: {enable(): Promise<void>; getState?(): Promise<{enabled: boolean}>};
  };
  clients: {
    claim(): Promise<void>;
    matchAll(o?: {type?: string}): Promise<{url: string; navigate?(url: string): Promise<unknown>}[]>;
  };
  skipWaiting(): Promise<void>;
  location: Location;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as WorkerScope;
const build = __NEXT_BUILD__;
const CACHE = cacheName(build.version);
const ASSETS = new Set(build.assets);
const SHELL = build.base;
/** How long a navigation waits for the network before the cached shell answers (lie-fi). */
const NAVIGATION_TIMEOUT = 4000;
// Kept across worker restarts; expires so a lost recovery message cannot pin navigations to the old shell.
const UNREACHABLE_KEY = `${build.base}__unreachable`;
const UNREACHABLE_TTL = 60_000;

async function markUnreachable(unreachable: boolean): Promise<void> {
  if (!await alive()) return;
  const cache = await caches.open(CACHE);
  if (unreachable) await cache.put(UNREACHABLE_KEY, new Response(String(Date.now())));
  else await cache.delete(UNREACHABLE_KEY);
}
/** The kill switch is checked at most this often while online. */
const KILL_CHECK = 30 * 60_000;

/** Retirement forbids recreating caches; a missing build cache preserves that state across restarts. */
let retired = false;

async function alive(): Promise<boolean> {
  return !retired && await caches.has(CACHE);
}

async function killSelf(): Promise<void> {
  retired = true;
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  await sw.registration.unregister();
}

async function precache(): Promise<void> {
  const shell = await fetch(SHELL, {cache: 'no-cache', credentials: 'same-origin'});
  if (!shell.ok) throw new Error(`the app shell answered ${String(shell.status)}`);
  const html = await shell.clone().text();
  // A mismatched shell may require assets this worker cannot provide.
  if (buildOf(html) !== build.version) throw new Error(`the shell is build ${buildOf(html) ?? '?'}, not ${build.version}`);
  const cache = await caches.open(CACHE);
  const lazy = new Set(build.lazy);
  await cache.addAll(build.assets.filter((a) => !lazy.has(a)).map((a) => build.base + a));
  // Last: a failed install leaves no shell that could be served without its assets.
  await cache.put(SHELL, cachedShell(html, shell));
}

sw.addEventListener('install', (e) => {
  if (build.kill) {
    e.waitUntil(sw.skipWaiting());
    return;
  }
  e.waitUntil(precache());
});

sw.addEventListener('activate', (e) => {
  if (build.kill) {
    e.waitUntil(killSelf());
    return;
  }
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== CACHE && k !== AVATAR_CACHE) await caches.delete(k);
    await sw.registration.navigationPreload?.enable().catch(() => undefined);
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (e) => {
  const m = e.data as {t?: string; urls?: unknown} | null;
  if (m?.t === 'retire') retired = true;
  else if (m?.t === 'unreachable') e.waitUntil(markUnreachable(true));
  else if (m?.t === 'reachable') e.waitUntil(markUnreachable(false));
  else if (m?.t === 'skipWaiting') e.waitUntil(sw.skipWaiting());
  else if (m?.t === 'version') e.source?.postMessage({t: 'version', version: build.version});
  else if (m?.t === 'avatars' && Array.isArray(m.urls)) e.waitUntil(keepAvatars(m.urls.filter((u): u is string => typeof u === 'string').slice(0, 200)));
});

/** Cache pre-control avatars for offline use, restricted to this instance's avatar URLs. */
async function keepAvatars(urls: string[]): Promise<void> {
  if (!await alive()) return;
  const cache = await caches.open(AVATAR_CACHE);
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u, sw.location.origin);
    } catch {
      continue;
    }
    const site = sitePathOf(url.pathname, SUB);
    if (url.origin !== sw.location.origin || site === undefined || !isAvatarPath(site) || await cache.match(url.href)) continue;
    const res = await fetch(url.href, {credentials: 'same-origin'}).catch(() => undefined);
    if (res?.ok && res.type === 'basic') await cache.put(url.href, res).catch(() => undefined);
  }
  trimAvatarsSoon();
}

/** The instance's sub-path ("" or "/git"). */
const SUB = new URL(sw.registration.scope).pathname.replace(/\/$/, '');

/** Only canonical routes and the shell base are app documents, not other base-prefixed paths. */
function appPage(path: string, search: string): boolean {
  if (path === build.base) return true;
  const site = sitePathOf(path, SUB);
  return site !== undefined && isSpaRoute(site, search);
}

sw.addEventListener('fetch', (e) => {
  if (build.kill) return;
  const s = strategy(e.request, sw.location.origin, build.base, SUB);
  if (s === 'asset') e.respondWith(asset(e.request));
  else if (s === 'avatar') e.respondWith(avatar(e.request));
  // Top-level documents only (not frames); everything else is the browser's.
  else if (s === 'navigate' && e.request.destination === 'document') e.respondWith(navigate(e));
});

const AVATARS_MAX = 500;
/** A page shows many avatars at once: enumerate the cache once per burst, not once per avatar. */
const AVATAR_TRIM_DELAY = 2000;
let avatarTrim: Promise<void> | undefined;

function trimAvatarsSoon(): void {
  avatarTrim ??= new Promise<void>((resolve) => setTimeout(resolve, AVATAR_TRIM_DELAY)).then(async () => {
    const cache = await caches.open(AVATAR_CACHE);
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - AVATARS_MAX))) await cache.delete(k);
  }).catch(() => undefined).finally(() => {
    avatarTrim = undefined;
  });
}

async function avatar(req: Request): Promise<Response> {
  if (!await alive()) return fetch(req);
  const cache = await caches.open(AVATAR_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      void cache.put(req, res.clone()).then(trimAvatarsSoon, () => undefined);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function asset(req: Request): Promise<Response> {
  if (!await alive()) return fetch(req);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Only this build's files are kept (a newer build's chunks belong to its own worker's cache).
  const path = new URL(req.url).pathname.slice(build.base.length);
  if (res.ok && ASSETS.has(path)) void cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

/**
 * Preload preserves document-navigation headers needed for server app/classic selection.
 * Only app pages time out to the cached shell; slow classic responses must not be replaced.
 */
async function navigate(e: FetchEvent): Promise<Response> {
  const url = new URL(e.request.url);
  const path = url.pathname;
  // Explicit classic-page queries must not count as browser opt-out.
  const app = appPage(path, url.search);
  if (!navigator.onLine) return offline();
  // Without preload, shell fetches cannot prove opt-in or opt-out; mark them and skip kill checks.
  const via = {preload: true};
  const net = e.preloadResponse.then(async (r: Response | undefined) => {
    if (r) return r;
    via.preload = false;
    if (!app) return await fetch(e.request);
    const res = await fetch(SHELL, {cache: 'no-cache', credentials: 'same-origin'});
    return res.ok ? cachedShell(await res.text(), res) : res;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (app && await alive()) {
      const cache = await caches.open(CACHE);
      const known = await cache.match(UNREACHABLE_KEY);
      if (known && Date.now() - Number(await known.text()) < UNREACHABLE_TTL) {
        const cached = await shell();
        if (cached) {
          e.waitUntil(net.then(async (res) => {
            await markUnreachable(false);
            if (via.preload) await afterOnline(path, app, res);
          }).catch(() => undefined));
          return cached;
        }
      }
    }
    if (app) {
      const slow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => {
          resolve('slow');
        }, NAVIGATION_TIMEOUT);
      });
      if (await Promise.race([net, slow]) === 'slow') {
        const cached = await shell();
        if (cached) {
          await markUnreachable(true);
          e.waitUntil(net.then(async (res) => {
            await markUnreachable(false);
            if (via.preload) await afterOnline(path, app, res);
          }).catch(() => undefined));
          return cached;
        }
      }
    }
    const res = await net;
    if (app) await markUnreachable(false);
    if (via.preload) e.waitUntil(afterOnline(path, app, res));
    return res;
  } catch {
    return await offline();
  } finally {
    clearTimeout(timer);
  }
}

/** Mark cached boots as non-evidence of opt-in, and strip headers invalid for a decoded body. */
function cachedShell(html: string, from: Response): Response {
  const headers = new Headers(from.headers);
  for (const h of ['Content-Encoding', 'Content-Length', 'Set-Cookie']) headers.delete(h);
  return new Response(html.replace(/<head[^>]*>/i, (m) => `${m}<meta name="forgejo-next-cached" content="1">`), {status: 200, headers});
}

async function offline(): Promise<Response> {
  return await shell() ?? new Response('Offline', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
}

async function shell(): Promise<Response | undefined> {
  return (await caches.open(CACHE)).match(SHELL, {ignoreVary: true});
}

/** Persist kill-check timing because idle workers restart. */
const KILL_KEY = `${build.base}__kill-check`;

async function afterOnline(path: string, app: boolean, res: Response): Promise<void> {
  if (!await alive()) return;
  const cache = await caches.open(CACHE);
  // A missing app page warrants checking whether sw.js is still served.
  let check = res.status === 404 && path.startsWith(build.base);
  if (app && res.ok && res.headers.get('Content-Type')?.includes('text/html')) {
    // Only the app's documents are read (never a classic page's body).
    const html = await res.clone().text().catch(() => '');
    const theirs = buildOf(html);
    if (theirs && theirs !== build.version) void sw.registration.update().catch(() => undefined);
    // Refresh same-build config and CSP.
    else if (theirs === build.version) await cache.put(SHELL, cachedShell(html, res));
    // A classic response to an app route signals browser opt-out.
    else if (!theirs && html) {
      await killSelf();
      return;
    }
  }
  if (!check) {
    const last = Number(await (await cache.match(KILL_KEY))?.text() ?? 0);
    check = Date.now() - last > KILL_CHECK;
  }
  if (!check) return;
  await cache.put(KILL_KEY, new Response(String(Date.now())));
  const me = await fetch(`${build.base}sw.js`, {cache: 'no-store', credentials: 'same-origin'}).catch(() => undefined);
  if (me && (me.status === 404 || me.status === 410)) await killSelf();
}
