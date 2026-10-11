// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {beforeEach, expect, test, vi} from 'vitest';
import type * as Api from '../../app/api.ts';
import {type OnlineRequest, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {CodeCache} from '../../code/cache.ts';
import {SettingsSource} from './data.ts';
import type {UserSettings} from './payload.ts';

const calls: OnlineRequest[] = [];
let answer: (req: OnlineRequest) => unknown = () => undefined;

vi.mock('../../app/api.ts', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    online: (_app: unknown, req: OnlineRequest) => {
      calls.push(req);
      try {
        return Promise.resolve(answer(req));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
});

function memoryCache(): CodeCache {
  const m = new Map<string, unknown>();
  return {
    peek: (k: string) => m.get(k),
    get: (k: string) => Promise.resolve(m.get(k)),
    put: (k: string, v: unknown) => m.set(k, v),
    delete: (k: string) => m.delete(k),
  } as unknown as CodeCache;
}

const settings: UserSettings = {
  full_name: 'Ada', website: '', description: '', location: '', pronouns: '', language: 'en-US', theme: 'forgejo-auto', diff_view_style: '',
  enable_repo_unit_hints: true, hide_email: false, hide_pronouns: false, hide_activity: false,
};

beforeEach(() => {
  calls.length = 0;
  answer = () => undefined;
});

async function loaded(): Promise<SettingsSource> {
  const src = new SettingsSource({} as App, memoryCache(), 7);
  answer = (req) => (req.path === '/user/settings' ? settings : [{email: 'a@x.org', verified: true, primary: true}, {email: 'b@x.org', verified: true, primary: false}]);
  await src.load('settings');
  await src.load('emails');
  return src;
}

test('a switch shows at once and goes back when Forgejo refuses', async () => {
  const src = await loaded();
  let release!: () => void;
  answer = () => new Promise((_, reject) => {
    release = () => {
      reject(new RequestFailed(403, 'token does not have at least one of required scope(s): [write:user]'));
    };
  });
  const p = src.patch({hide_email: true}, true);
  expect(src.value('settings')?.hide_email).toBe(true);
  expect(calls.at(-1)).toMatchObject({method: 'PATCH', api: 'v1', path: '/user/settings', body: {hide_email: true}});
  release();
  await expect(p).rejects.toThrow(/scope/);
  expect(src.value('settings')?.hide_email).toBe(false);
});

test('a profile save shows Forgejo\'s answer, not the draft', async () => {
  const src = await loaded();
  answer = () => ({...settings, full_name: 'Ada King'});
  await src.patch({full_name: 'Ada King '}, false);
  expect(src.value('settings')?.full_name).toBe('Ada King');
});

test('the primary address switches at once (the gap endpoint), and back on a refusal', async () => {
  const src = await loaded();
  answer = () => {
    throw new RequestFailed(422, 'only a verified email address can be the primary one');
  };
  const p = src.makePrimary('b@x.org');
  expect(src.value('emails')?.find((e) => e.primary)?.email).toBe('b@x.org');
  await expect(p).rejects.toThrow(/verified/);
  expect(calls.at(-1)).toMatchObject({method: 'PUT', api: 'sync', path: '/user/emails/primary', body: {email: 'b@x.org'}});
  expect(src.value('emails')?.find((e) => e.primary)?.email).toBe('a@x.org');
});

test('a removed address leaves at once and comes back when Forgejo refuses', async () => {
  const src = await loaded();
  answer = () => {
    throw new RequestFailed(500, 'nope');
  };
  const p = src.deleteEmail('b@x.org');
  expect(src.value('emails')?.map((e) => e.email)).toEqual(['a@x.org']);
  await expect(p).rejects.toThrow('nope');
  expect(calls.at(-1)).toMatchObject({method: 'DELETE', path: '/user/emails', body: {emails: ['b@x.org']}});
  expect(src.value('emails')?.map((e) => e.email).sort()).toEqual(['a@x.org', 'b@x.org']);
});

test('keys are read page by page', async () => {
  const src = new SettingsSource({} as App, memoryCache(), 7);
  const page = (n: number) => Array.from({length: n}, (_, i) => ({id: i, key: 'k', created_at: ''}));
  answer = (req) => (req.path.includes('page=1&') ? page(50) : req.path.includes('page=2&') ? page(3) : []);
  await src.load('keys');
  expect(src.value('keys')).toHaveLength(53);
  expect(calls.map((c) => c.path)).toEqual(['/user/keys?page=1&limit=50', '/user/keys?page=2&limit=50']);
});
