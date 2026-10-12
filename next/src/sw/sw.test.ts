// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

test('a timed-out navigation is remembered across worker restarts', async () => {
  vi.useFakeTimers();
  const entries = new Map<string, Response>([['/-/next/', new Response('cached shell')]]);
  const cache = {
    match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
    put: (key: string, value: Response) => { entries.set(key, value); return Promise.resolve(); },
    delete: (key: string) => Promise.resolve(entries.delete(key)),
  };
  vi.stubGlobal('caches', {has: () => Promise.resolve(true), open: () => Promise.resolve(cache)});
  vi.stubGlobal('__NEXT_BUILD__', {version: 'test', base: '/-/next/', assets: [], lazy: [], kill: false});
  interface Navigation {request: {url: string; mode: string; destination: string; method: string}; preloadResponse: Promise<Response | undefined>; waitUntil: (p: Promise<unknown>) => void; respondWith: (p: Promise<Response>) => void}
  let fetchListener: (event: Navigation) => void = () => undefined;
  vi.stubGlobal('self', {
    registration: {scope: 'http://localhost/'},
    location: {origin: 'http://localhost'},
    addEventListener: (type: string, listener: (event: Navigation) => void) => { if (type === 'fetch') fetchListener = listener; },
  });
  const navigation = () => {
    let response: Promise<Response> = Promise.reject(new Error('no response'));
    void response.catch(() => undefined);
    fetchListener({
      request: {url: 'http://localhost/-/next/', mode: 'navigate', destination: 'document', method: 'GET'},
      preloadResponse: new Promise(() => undefined),
      waitUntil: () => undefined,
      respondWith: (p) => { response = p; },
    });
    return response;
  };
  await import('./sw.ts');
  const first = navigation();
  await vi.advanceTimersByTimeAsync(4000);
  expect(await (await first).text()).toBe('cached shell');
  vi.resetModules();
  await import('./sw.ts');
  expect(await (await navigation()).text()).toBe('cached shell');
});

test('a burst of avatar fetches trims the avatar cache once, down to its cap', async () => {
  vi.useFakeTimers();
  const entries: string[] = Array.from({length: 499}, (_, i) => `old-${String(i)}`);
  const cache = {
    put: (req: {url: string}) => { entries.push(req.url); return Promise.resolve(); },
    keys: vi.fn(() => Promise.resolve(entries.slice())),
    delete: (key: string) => { entries.splice(entries.indexOf(key), 1); return Promise.resolve(true); },
    match: () => Promise.resolve(undefined),
  };
  vi.stubGlobal('caches', {has: () => Promise.resolve(true), open: () => Promise.resolve(cache)});
  const png = {ok: true, type: 'basic', clone: () => png};
  vi.stubGlobal('fetch', () => Promise.resolve(png));
  vi.stubGlobal('__NEXT_BUILD__', {version: 'test', base: '/-/next/', assets: [], lazy: [], kill: false});
  interface AvatarFetch {request: {url: string; mode: string; destination: string; method: string}; respondWith: (p: Promise<unknown>) => void}
  let fetchListener: (event: AvatarFetch) => void = () => undefined;
  vi.stubGlobal('self', {
    registration: {scope: 'http://localhost/'},
    location: {origin: 'http://localhost'},
    addEventListener: (type: string, listener: (event: AvatarFetch) => void) => { if (type === 'fetch') fetchListener = listener; },
  });
  await import('./sw.ts');
  const responses: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    fetchListener({
      request: {url: `http://localhost/avatars/${String(i)}`, mode: 'no-cors', destination: 'image', method: 'GET'},
      respondWith: (p) => { responses.push(p); },
    });
  }
  await Promise.all(responses);
  await vi.advanceTimersByTimeAsync(2000);
  expect(cache.keys).toHaveBeenCalledTimes(1);
  expect(entries).toHaveLength(500);
  expect(entries.at(-1)).toBe('http://localhost/avatars/4');
});
