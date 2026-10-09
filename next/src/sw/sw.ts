// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The service worker (PLAN §4.10, §5.2 step 5, §10 "Stale service worker"),
// served by B8 at {base}sw.js with Service-Worker-Allowed: {sub-path}/ and
// registered by the app after its first paint (app/sw.ts). Built on its own
// (tools/vite-plugin-sw.ts), with this build's version and asset list.
//
//   install    caches this build: the app shell (index.html, checked to be
//              this build's) and every hashed asset — all or nothing, so an
//              offline boot never misses a chunk — but the code worker's
//              grammars, cached when first used (prefetch warms the ones a
//              prefetched pull request needs: src/code/prefetch.ts). It waits (versioned
//              activation): the page offers "Reload" when a new build is
//              ready, and the new worker activates then, or once every tab of
//              the old one is closed.
//   activate   drops other builds' caches; navigation preload.
//   assets     cache first (immutable, hashed names).
//   navigate   online: the network first, always (B8: never answer from cache
//              while online without asking the network), as the browser's
//              own request (navigation preload; see `navigate`). Offline
//              (navigator.onLine, a failed request, or an app page with no
//              answer in 4 s) → the cached shell; the app renders the route
//              from IndexedDB, or says what is available offline.
//   kill       sw.js answering 404/410 (the UI is not served any more; checked
//              at most every 30 min, and when one of the app's own pages
//              answers 404), or a build made with NEXT_SW_KILL=1:
//              the worker deletes its caches and unregisters itself.

import {AVATAR_CACHE, buildOf, CACHE_PREFIX, cacheName, isAvatarPath, isSpaRoute, sitePathOf, strategy} from './routes.ts';

interface Build {
  version: string;
  /** The app's base URL (rewritten by B8 under a sub-path). */
  base: string;
  /** Asset paths below the base. */
  assets: string[];
  /** Of those, the ones cached on first use, not at install (the code worker's grammars: ≈ 3 MB). */
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
const SHELL = build.base;
/** How long a navigation waits for the network before the cached shell answers (lie-fi). */
const NAVIGATION_TIMEOUT = 4000;
/** The kill switch is checked at most this often while online. */
const KILL_CHECK = 30 * 60_000;

/**
 * Retired (the kill switch, from this worker or a page): it still answers the open tabs until they reload, from the
 * network only, and never opens a cache again (a chunk or an avatar fetched meanwhile recreated one). The build's
 * cache exists from install until a kill deletes it, so its absence says so too, after the worker restarted.
 */
let retired = false;

async function alive(): Promise<boolean> {
  return !retired && await caches.has(CACHE);
}

async function killSelf(): Promise<void> {
  retired = true;
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  await sw.registration.unregister();
  // The open tabs load from the network again (their pages stay as they are until then).
}

async function precache(): Promise<void> {
  const shell = await fetch(SHELL, {cache: 'no-cache', credentials: 'same-origin'});
  if (!shell.ok) throw new Error(`the app shell answered ${String(shell.status)}`);
  const html = await shell.clone().text();
  // The server may already run a newer build: then this worker's assets are not what the shell needs (the next sw.js is).
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
  else if (m?.t === 'skipWaiting') e.waitUntil(sw.skipWaiting());
  else if (m?.t === 'version') e.source?.postMessage({t: 'version', version: build.version});
  else if (m?.t === 'avatars' && Array.isArray(m.urls)) e.waitUntil(keepAvatars(m.urls.filter((u): u is string => typeof u === 'string').slice(0, 200)));
});

/**
 * The avatars a page showed before this worker controlled it (the first load after signing in): fetched into
 * the avatars' cache, so they show offline too. Only this instance's avatar URLs; those cached already are kept.
 */
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
}

/** The instance's sub-path ("" or "/git"). */
const SUB = new URL(sw.registration.scope).pathname.replace(/\/$/, '');

/**
 * Whether a path is one of the app's documents: its canonical routes (B8
 * spaRoutes) and its base. Other paths below the base (opt-in, opt-out, the
 * callback, files) go to the network as themselves.
 */
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

/** Avatars kept at most (oldest first out). */
const AVATARS_MAX = 500;

/**
 * An avatar: the network first (a changed picture shows), a copy kept for when the network is not there
 * (offline the app still shows faces, not broken images).
 */
async function avatar(req: Request): Promise<Response> {
  if (!await alive()) return fetch(req);
  const cache = await caches.open(AVATAR_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      void cache.put(req, res.clone()).then(async () => {
        const keys = await cache.keys();
        for (const k of keys.slice(0, Math.max(0, keys.length - AVATARS_MAX))) await cache.delete(k);
      }).catch(() => undefined);
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
  if (res.ok && build.assets.includes(path)) void cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

/**
 * A top-level navigation. Online it is the browser's own request — navigation
 * preload (cookies, Sec-Fetch-Dest: document, on which B8 decides between the
 * app and the classic page); a request made here would not be a document
 * navigation to the server. Without preload, the app's pages get the app's
 * document from the network and other pages a plain fetch (the same classic
 * page). Offline — navigator.onLine, a failed request, or an app page that
 * does not answer within 4 s — the cached shell answers: the app renders the
 * route from IndexedDB, or says what is available offline. A classic page is
 * never replaced by the shell while the network answers, however slowly.
 */
async function navigate(e: FetchEvent): Promise<Response> {
  const url = new URL(e.request.url);
  const path = url.pathname;
  // A canonical route asked for as the classic page (?ui=classic, a profile tab) is the classic page: never
  // the shell, and its answer is no sign of an opt-out.
  const app = appPage(path, url.search);
  if (!navigator.onLine) return offline();
  // Without preload an app page gets the app's document whatever the opt-in cookie says: marked like the
  // cached shell (no opt-in from it), and never read as the server's choice (no kill).
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
    if (app) {
      const slow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => {
          resolve('slow');
        }, NAVIGATION_TIMEOUT);
      });
      if (await Promise.race([net, slow]) === 'slow') {
        const cached = await shell();
        if (cached) {
          void net.catch(() => undefined);
          return cached;
        }
      }
    }
    const res = await net;
    if (via.preload) e.waitUntil(afterOnline(path, app, res));
    return res;
  } catch {
    return await offline();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The shell as cached: marked (`forgejo-next-cached`: a boot from it is not a
 * proof that the browser opted in, so it does not opt in again) and with the
 * headers of a decoded body.
 */
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

/** When the kill switch was last checked (kept in the cache: the worker restarts after every idle spell). */
const KILL_KEY = `${build.base}__kill-check`;

/** An online navigation: the kill switch, and a newer build on the server. */
async function afterOnline(path: string, app: boolean, res: Response): Promise<void> {
  if (!await alive()) return;
  const cache = await caches.open(CACHE);
  // One of the app's own pages is gone: the server may not serve this UI any more — sw.js says.
  let check = res.status === 404 && path.startsWith(build.base);
  if (app && res.ok && res.headers.get('Content-Type')?.includes('text/html')) {
    // Only the app's documents are read (never a classic page's body).
    const html = await res.clone().text().catch(() => '');
    const theirs = buildOf(html);
    if (theirs && theirs !== build.version) void sw.registration.update().catch(() => undefined);
    // The same build: keep the freshest shell (config and CSP as served now).
    else if (theirs === build.version) await cache.put(SHELL, cachedShell(html, res));
    // An app page answered with a classic page: this browser opted out (the classic toggle) — the worker goes.
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
