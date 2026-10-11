// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, ensureUser, ok} from '../lib/api.ts';
import {sidebar, signedIn, watch} from '../lib/app.ts';
import {ALICE, BASE, basic} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('search finds a public repository outside the workspace and opens it in Next', async ({browser}) => {
  const suffix = Date.now().toString(36);
  const org = `discover-${suffix}`;
  const repo = `outside-${suffix}`;
  await ensureUser(org);
  try {
    await ok(await api('POST', '/user/repos', {name: repo, private: false, auto_init: true}, basic(org, ALICE.password)), 'create external repository');
    const ctx = await browser.newContext();
    try {
      const page = await signedIn(ctx);
      const problems = watch(page);
      await sidebar(page).getByRole('link', {name: 'Explore', exact: true}).click();
      await expect(page.getByRole('heading', {name: 'Explore', exact: true})).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByPlaceholder('Search repositories, issues, files, people and commands…').fill(repo);
      await page.getByText('See all results', {exact: true}).click();
      await expect(page).toHaveURL(/\/search\?/);
      await page.getByRole('option', {name: `${org}/${repo}`}).click();
      await expect(page).toHaveURL(`${BASE}/${org}/${repo}`);
      await expect(sidebar(page)).toBeVisible();
      expect(problems).toEqual([]);
    } finally { await ctx.close(); }
  } finally {
    await api('DELETE', `/repos/${org}/${repo}`);
    await api('DELETE', `/admin/users/${org}`);
  }
});
