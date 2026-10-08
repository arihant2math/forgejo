// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The page's side of the service worker (src/sw/sw.ts): registered after
// the first paint (when idle; the worker then precaches this build), the
// update path (a new build installed and waiting → "Reload" → it activates
// and the page reloads into it; notice{new_build} from the sync session
// makes the browser look for it at once), and the kill switch's page side
// (no worker served → unregister). Its own chunk.

import {notify} from './notices.ts';
import type {App} from './store.ts';
import {workerScriptURL} from './trusted.ts';

let started = false;

export function startServiceWorker(app: App): void {
  const container = (navigator as Partial<Navigator>).serviceWorker;
  if (started || !container || import.meta.env.DEV) return;
  started = true;
  const scope = `${app.config.app_sub_url}/`;
  let reloading = false;
  let offered = false;
  const offer = (reg: ServiceWorkerRegistration) => {
    if (offered || !reg.waiting || !container.controller) return;
    offered = true;
    notify(app, {
      tone: 'neutral', sticky: true, title: 'A new version is ready',
      description: 'Reload to use it. Changes not synced yet are kept.',
      action: {label: 'Reload', run: () => {
        reloading = true;
        // Another tab may have activated it already: then this one only needs to reload.
        if (reg.waiting) reg.waiting.postMessage({t: 'skipWaiting'});
        else location.reload();
      }},
    });
  };
  container.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  /** The kill switch, page side: no worker served any more ⇒ none stays registered, nothing stays cached. */
  const killed = async (): Promise<boolean> => {
    const res = await fetch(`${app.config.base}sw.js`, {cache: 'no-store'}).catch(() => undefined);
    if (!res || (res.status !== 404 && res.status !== 410)) return false;
    const old = await container.getRegistration(scope).catch(() => undefined);
    await old?.unregister();
    for (const k of await caches.keys()) if (k.startsWith('forgejo-next-')) await caches.delete(k);
    return true;
  };
  void (async () => {
    let reg: ServiceWorkerRegistration;
    try {
      reg = await container.register(workerScriptURL(app.config.base), {scope, updateViaCache: 'none'});
      // register() resolves at once for a worker already registered: look for a new one (or none) now.
      await reg.update();
    } catch (err) {
      if (await killed()) return;
      console.warn('service worker: not registered or updated', err);
      return;
    }
    const watch = (w: ServiceWorker | null) => {
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed') offer(reg);
      });
    };
    offer(reg);
    // An install the browser started before this code ran (its updatefound has fired already).
    watch(reg.installing);
    reg.addEventListener('updatefound', () => {
      watch(reg.installing);
    });
    app.session?.data.on('newBuild', () => {
      void reg.update().catch(() => killed());
    });
  })();
}

/**
 * Back to the classic UI: the worker goes too (it would keep answering this
 * instance's navigations offline with this app), and so does its cache.
 */
export async function removeServiceWorker(app: App): Promise<void> {
  const container = (navigator as Partial<Navigator>).serviceWorker;
  const reg = await container?.getRegistration(`${app.config.app_sub_url}/`).catch(() => undefined);
  await reg?.unregister().catch(() => false);
  for (const k of await caches.keys().catch(() => [])) if (k.startsWith('forgejo-next-')) await caches.delete(k);
}
