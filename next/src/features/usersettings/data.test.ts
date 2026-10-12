// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {beforeEach, expect, test, vi} from 'vitest';
import type * as Api from '../../app/api.ts';
import {type OnlineRequest, RequestFailed} from '../../app/api.ts';
import type {Resource} from '../../app/resource.ts';
import type {App} from '../../app/store.ts';
import {sessionCache} from '../../code/cache.ts';
import {openDatabase} from '../../data/idb.ts';
import {deleteEmail, makePrimary, patchSettings, prefetchUserSettings} from './data.ts';
import type {ApiEmail, UserSettings} from './payload.ts';

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

const app = {} as App;

const settings: UserSettings = {
  full_name: 'Ada', website: '', description: '', location: '', pronouns: '', language: 'en-US', theme: 'forgejo-auto', diff_view_style: '',
  enable_repo_unit_hints: true, hide_email: false, hide_pronouns: false, hide_activity: false,
};

/** A loaded resource whose updates apply at once, as the hook's do. */
function loaded<T>(value: T): Resource<T> {
  let v: T | undefined = value;
  return {
    get value() {
      return v;
    },
    state: 'ready', fresh: true, reload: vi.fn(),
    update: (fn: (old: T | undefined) => T) => {
      v = fn(v);
    },
  } as unknown as Resource<T>;
}

const emails = (): ApiEmail[] => [{email: 'a@x.org', verified: true, primary: true}, {email: 'b@x.org', verified: true, primary: false}];

beforeEach(() => {
  calls.length = 0;
  answer = () => undefined;
});

test('a switch shows at once and goes back when Forgejo refuses', async () => {
  const res = loaded(settings);
  let release!: () => void;
  answer = () => new Promise((_, reject) => {
    release = () => {
      reject(new RequestFailed(403, 'token does not have at least one of required scope(s): [write:user]'));
    };
  });
  const p = patchSettings(app, res, {hide_email: true}, true);
  expect(res.value?.hide_email).toBe(true);
  expect(calls.at(-1)).toMatchObject({method: 'PATCH', api: 'v1', path: '/user/settings', body: {hide_email: true}});
  release();
  await expect(p).rejects.toThrow(/scope/);
  expect(res.value?.hide_email).toBe(false);
});

test('a profile save shows Forgejo\'s answer, not the draft', async () => {
  const res = loaded(settings);
  answer = () => ({...settings, full_name: 'Ada King'});
  await patchSettings(app, res, {full_name: 'Ada King '}, false);
  expect(res.value?.full_name).toBe('Ada King');
});

test('the primary address switches at once (the gap endpoint), and back on a refusal', async () => {
  const res = loaded(emails());
  answer = () => {
    throw new RequestFailed(422, 'only a verified email address can be the primary one');
  };
  const p = makePrimary(app, res, 'b@x.org');
  expect(res.value?.find((e) => e.primary)?.email).toBe('b@x.org');
  await expect(p).rejects.toThrow(/verified/);
  expect(calls.at(-1)).toMatchObject({method: 'PUT', api: 'sync', path: '/user/emails/primary', body: {email: 'b@x.org'}});
  expect(res.value?.find((e) => e.primary)?.email).toBe('a@x.org');
});

test('a removed address leaves at once and comes back when Forgejo refuses', async () => {
  const res = loaded(emails());
  answer = () => {
    throw new RequestFailed(500, 'nope');
  };
  const p = deleteEmail(app, res, 'b@x.org');
  expect(res.value?.map((e) => e.email)).toEqual(['a@x.org']);
  await expect(p).rejects.toThrow('nope');
  expect(calls.at(-1)).toMatchObject({method: 'DELETE', path: '/user/emails', body: {emails: ['b@x.org']}});
  expect(res.value?.map((e) => e.email).sort()).toEqual(['a@x.org', 'b@x.org']);
});

test('a prefetch reads keys page by page into the user’s cache', async () => {
  const db = await openDatabase(1, {factory: new IDBFactory()});
  const withSession = {session: {userId: 7, data: {db}}} as unknown as App;
  const page = (n: number) => Array.from({length: n}, (_, i) => ({id: i, key: 'k', created_at: ''}));
  answer = (req) => (req.path.includes('page=1&') ? page(50) : req.path.includes('page=2&') ? page(3) : []);
  prefetchUserSettings(withSession, ['keys']);
  await vi.waitFor(() => {
    expect(sessionCache(db).peek<unknown[]>('uset:0:7:keys')).toHaveLength(53);
  });
  expect(calls.map((c) => c.path)).toEqual(['/user/keys?page=1&limit=50', '/user/keys?page=2&limit=50']);
});
