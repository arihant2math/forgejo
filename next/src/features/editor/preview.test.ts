// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import type {App} from '../../app/store.ts';
import {renderPreview} from './Composer.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const app = {config: {...fallbackConfig(), app_sub_url: '', base: '/-/next/'}, session: {auth: {token: () => Promise.resolve('t0k')}}, ui: {}} as unknown as App;

test('previews asked for together share one request (B9 batch), keyed by repository; answers are cached', async () => {
  const calls: {url: string; body: {repo_id?: number; items: string[]}; headers: Record<string, string>}[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {repo_id?: number; items: string[]};
    calls.push({url, body, headers: init.headers as Record<string, string>});
    return Promise.resolve(new Response(JSON.stringify({html: body.items.map((t) => `<p>${t}</p>`)}), {status: 200}));
  }));
  const [a, b, c] = await Promise.all([renderPreview(app, 7, 'one'), renderPreview(app, 7, 'two'), renderPreview(app, 0, 'three')]);
  expect([a, b, c]).toEqual(['<p>one</p>', '<p>two</p>', '<p>three</p>']);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe('/-/sync/api/markdown');
  expect(calls[0]?.body).toEqual({repo_id: 7, items: ['one', 'two']});
  expect(calls[1]?.body).toEqual({items: ['three']});
  expect(calls[0]?.headers.Authorization).toBe('Bearer t0k');
  expect(await renderPreview(app, 7, 'one')).toBe('<p>one</p>');
  expect(calls).toHaveLength(2);
});

test('a failed preview rejects with the server\'s message', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({message: 'too large'}), {status: 413}))));
  await expect(renderPreview(app, 7, 'big')).rejects.toThrow('too large');
});
