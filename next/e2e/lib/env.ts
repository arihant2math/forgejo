// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server the `forgejo` project runs against (tools/dev-forgejo.sh e2e
// sets these): its URL, the site admin dev-forgejo.sh creates, the second
// user the seeds create, and the build Forgejo serves (ASSETS_DIR).

import {resolve} from 'node:path';

export const BASE = process.env.NEXT_FORGEJO_URL?.replace(/\/$/, '') ?? '';
export const USER = process.env.NEXT_FORGEJO_USER ?? 'dev';
export const PASSWORD = process.env.NEXT_FORGEJO_PASSWORD ?? 'devdevdev1';
/** The database behind BASE (pg | mysql), for the record. */
export const DB = process.env.NEXT_E2E_DB ?? 'unknown';

export interface Who {
  user: string;
  password: string;
}

export const DEV: Who = {user: USER, password: PASSWORD};
/** tools/seed-issues.ts creates her (password alicealice1); `ensureUser` too. */
export const ALICE: Who = {user: 'alice', password: 'alicealice1'};

export const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
export const aliceAuth = basic(ALICE.user, ALICE.password);

/** The build Forgejo serves (ASSETS_DIR = next/dist): the update path and kill switch rewrite it in place. */
export const DIST = resolve(process.cwd(), 'dist');
