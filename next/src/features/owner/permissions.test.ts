// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {expect, test, vi} from 'vitest';
import type * as Api from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import {openDatabase} from '../../data/idb.ts';
import {orgPermissions} from './permissions.ts';

const online = vi.hoisted(() => vi.fn((_app: unknown, req: {path: string}) => Promise.resolve(req.path.includes('/orgs/acme/') ? {is_owner: false, is_admin: false, can_create_repository: true} : undefined)));
vi.mock('../../app/api.ts', async (orig) => ({...await orig<typeof Api>(), online}));

test('the new-repository owner list asks each organization’s permissions once, through the shared cache', async () => {
  const app = {session: {userId: 1, data: {db: await openDatabase(1, {factory: new IDBFactory()})}}} as unknown as App;
  const [a, b] = await Promise.all([orgPermissions(app, 'acme', 'alice'), orgPermissions(app, 'acme', 'alice')]);
  expect(a.can_create_repository).toBe(true);
  expect(b).toBe(a);
  expect(await orgPermissions(app, 'acme', 'alice')).toBe(a);
  expect(online).toHaveBeenCalledOnce();
  expect(online.mock.calls[0]?.[1].path).toBe('/users/alice/orgs/acme/permissions');
  expect(await orgPermissions(app, 'zeta', 'alice')).toEqual({is_owner: false, is_admin: false});
  expect(online).toHaveBeenCalledTimes(2);
});
