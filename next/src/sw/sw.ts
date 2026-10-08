// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The service worker (PLAN §4.10, §5.2 step 5, §10 "Stale service worker"),
// served by B8 at {base}sw.js with Service-Worker-Allowed: {sub-path}/ and
// registered by the app after its first paint (app/sw.ts). Built on its own
// (tools/vite-plugin-sw.ts), with this build's version and asset list.
//
//   install    caches this build: the app shell (index.html, checked to be
//              this build's) and every hashed asset — all or nothing, so an
//              offline boot never misses a chunk. It waits (versioned
//              activation): the page offers "Reload" when a new build is
//              ready, and the new worker activates then, or once every tab of
//              the old one is closed.
//   activate   drops other builds' caches; navigation preload.
//   assets     cache first (immutable, hashed names).
//   navigate   online: the network first, always (B8: never answer from cache
//              while online without asking the network), through navigation
//              preload only (see `preloading`). Offline (navigator.onLine,
//              a failed request, or no answer in 4 s) → the cached shell; the
//              app renders the route from IndexedDB, or its "not available
//              offline" page listing what is.
//   kill       sw.js answering 404/410 (the UI is not served any more), the
//              UI's base answering 404, or a build made with NEXT_SW_KILL=1:
//              the worker deletes its caches and unregisters itself.

import {BUILD_META, buildOf, CACHE_PREFIX, cacheName, isSpaRoute, sitePathOf, strategy} from './routes.ts';

interface Build {
  version: string;
  /** The app's base URL (rewritten by B8 under a sub-path). */
  base: string;
  /** Asset paths below the base. */
  assets: string[];
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
let lastKillCheck = 0;

async function killSelf(): Promise<void> {
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  await sw.registration.unregister();
  // The open tabs load from the network again (their pages stay as they are until then).
}

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE);
  const shell = await fetch(SHELL, {cache: 'no-cache', credentials: 'same-origin'});
  if (!shell.ok) throw new Error(`the app shell answered ${String(shell.status)}`);
  const html = await shell.clone().text();
  // The server may already run a newer build: then this worker's assets are not what the shell needs (the next sw.js is).
  if (buildOf(html) !== build.version) throw new Error(`the shell is build ${buildOf(html) ?? '?'}, not ${build.version}`);
  await cache.put(SHELL, shell);
  await cache.addAll(build.assets.map((a) => build.base + a));
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
    for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== CACHE) await caches.delete(k);
    if (sw.registration.navigationPreload) {
      await sw.registration.navigationPreload.enable().then(() => {
        preloading = true;
      }, () => undefined);
    }
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', (e) => {
  const m = e.data as {t?: string} | null;
  if (m?.t === 'skipWaiting') e.waitUntil(sw.skipWaiting());
  else if (m?.t === 'version') e.source?.postMessage({t: 'version', version: build.version});
});

/**
 * Navigation preload is on: an online navigation is the browser's own request
 * (cookies, Sec-Fetch-Dest: document — B8 decides app or classic page on
 * them). A request the worker made itself would not be a document navigation
 * to the server, so without preload the worker does not touch online navigations.
 */
let preloading = false;
void sw.registration.navigationPreload?.getState?.().then((st) => {
  preloading ||= st.enabled;
}).catch(() => undefined);

sw.addEventListener('fetch', (e) => {
  if (build.kill) return;
  const s = strategy(e.request, sw.location.origin, build.base);
  if (s === 'asset') e.respondWith(asset(e.request));
  else if (s === 'navigate') {
    if (!navigator.onLine) e.respondWith(offline());
    else if (preloading) e.respondWith(navigate(e));
  }
});

async function asset(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) void cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

async function navigate(e: FetchEvent): Promise<Response> {
  const net = e.preloadResponse.then((r) => r ?? fetch(e.request));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => {
      resolve('slow');
    }, NAVIGATION_TIMEOUT);
  });
  try {
    const first = await Promise.race([net, slow]);
    if (first === 'slow') {
      const cached = await shell();
      if (cached) {
        void net.catch(() => undefined);
        return cached;
      }
    }
    const res = await net;
    e.waitUntil(afterOnline(e.request, res));
    return res;
  } catch {
    // No network after all: the app (it renders what IndexedDB has, or tells what is available offline).
    return await offline();
  } finally {
    clearTimeout(timer);
  }
}

async function offline(): Promise<Response> {
  return await shell() ?? new Response('Offline', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
}

async function shell(): Promise<Response | undefined> {
  return (await caches.open(CACHE)).match(SHELL, {ignoreVary: true});
}

/** An online navigation: the kill switch, and a newer build on the server. */
async function afterOnline(req: Request, res: Response): Promise<void> {
  const path = new URL(req.url).pathname;
  if (res.status === 404 && path.startsWith(build.base)) {
    // The UI's own pages are gone: the server does not serve this UI (any more).
    await killSelf();
    return;
  }
  // Only the app's documents are read (never a classic page's body).
  const sub = new URL(sw.registration.scope).pathname.replace(/\/$/, '');
  const site = sitePathOf(path, sub);
  const app = path.startsWith(build.base) || (site !== undefined && isSpaRoute(site));
  const html = app && res.ok && res.headers.get('Content-Type')?.includes('text/html') ? await res.clone().text().catch(() => '') : '';
  const theirs = html.includes(BUILD_META) ? buildOf(html) : undefined;
  if (theirs && theirs !== build.version) {
    void sw.registration.update().catch(() => undefined);
  } else if (theirs === build.version) {
    // The same build: keep the freshest shell (config and CSP as served now).
    await (await caches.open(CACHE)).put(SHELL, new Response(html, {status: res.status, statusText: res.statusText, headers: res.headers}));
  }
  if (Date.now() - lastKillCheck < KILL_CHECK) return;
  lastKillCheck = Date.now();
  const me = await fetch(`${build.base}sw.js`, {cache: 'no-store', credentials: 'same-origin'}).catch(() => undefined);
  if (me && (me.status === 404 || me.status === 410)) await killSelf();
}
