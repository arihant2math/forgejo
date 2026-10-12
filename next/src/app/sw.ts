// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Registered after first paint; updates activate on request, while the kill switch unregisters and clears caches.

import {autorun} from 'mobx';
import {notify} from './notices.ts';
import type {App} from './store.ts';
import {workerScriptURL} from './trusted.ts';

let started = false;

export function startServiceWorker(app: App): void {
  const container = (navigator as Partial<Navigator>).serviceWorker;
  if (started || !container || import.meta.env.DEV) return;
  started = true;
  autorun(() => {
    const connection = app.session?.data.status.connection;
    if (connection === 'unreachable' || connection === 'live') {
      container.controller?.postMessage({t: connection === 'unreachable' ? 'unreachable' : 'reachable'});
    }
  });
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
  /** A missing worker script retires the controller and clears caches. */
  const killed = async (): Promise<boolean> => {
    const res = await fetch(`${app.config.base}sw.js`, {cache: 'no-store'}).catch(() => undefined);
    if (!res || (res.status !== 404 && res.status !== 410)) return false;
    const old = await container.getRegistration(scope).catch(() => undefined);
    // Unregister does not release this page's controller; retire it before clearing caches.
    container.controller?.postMessage({t: 'retire'});
    await old?.unregister();
    await dropCaches();
    return true;
  };
  void (async () => {
    let reg: ServiceWorkerRegistration;
    try {
      reg = await container.register(workerScriptURL(app.config.base), {scope, updateViaCache: 'none'});
      // register() may return an existing worker without checking for updates.
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
    // Cache avatars fetched before this page acquired a worker controller.
    void container.ready.then((r) => {
      const urls = [...document.images].map((i) => i.currentSrc || i.src).filter((u) => u.startsWith(location.origin));
      if (urls.length) r.active?.postMessage({t: 'avatars', urls});
    });
    // Include an install whose updatefound event already fired.
    watch(reg.installing);
    reg.addEventListener('updatefound', () => {
      watch(reg.installing);
    });
    app.session?.data.on('newBuild', () => {
      void reg.update().catch(() => killed());
    });
  })();
}

/** Removes worker and caches so classic navigations cannot fall back to the app offline. */
export async function removeServiceWorker(app: App): Promise<void> {
  const container = (navigator as Partial<Navigator>).serviceWorker;
  const reg = await container?.getRegistration(`${app.config.app_sub_url}/`).catch(() => undefined);
  container?.controller?.postMessage({t: 'retire'});
  await reg?.unregister().catch(() => false);
  await dropCaches();
}

/** Sweep twice: a retiring worker's in-flight fetch can reopen a cache after the first deletion. */
async function dropCaches(): Promise<void> {
  const sweep = async () => {
    for (const k of await caches.keys().catch(() => [])) if (k.startsWith('forgejo-next-')) await caches.delete(k);
  };
  await sweep();
  setTimeout(() => void sweep(), 2000);
}
