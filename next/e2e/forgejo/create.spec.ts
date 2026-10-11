// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The new repository and new organization forms (/repo/create,
// /org/create): reached from the account menu, a name checked as it is
// typed, created through API v1, and the new page painting from the pool;
// offline the button says why.

import {expect, test} from '@playwright/test';
import {api, apiJson, ok} from '../lib/api.ts';
import {sidebar, signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const RUN = Date.now().toString(36);
const REPO = `made-${RUN}`;
const ORG = `org-${RUN}`;
const NO_SCOPE = 'the UI\'s sign-in has no write:user / write:organization scope (PLAN §4.9, oauthapp.Scope)';

/** Whether the UI's sign-in may create repositories and organizations (its OAuth scope, as the config says). */
async function canCreate(): Promise<boolean> {
  const cfg = await (await fetch(`${BASE}/-/next/config`)).json() as {oauth?: {scope?: string} | null};
  const scopes = (cfg.oauth?.scope ?? '').split(/[\s,]+/);
  return scopes.includes('all') || (scopes.includes('write:user') && scopes.includes('write:organization'));
}

test('without the scope, the forms say so up front and offer the classic form', async ({browser}) => {
  test.skip(await canCreate(), 'the UI\'s sign-in has the write:user and write:organization scopes');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/repo/create`);
  const note = page.getByRole('note').filter({hasText: 'Forgejo Next cannot create repositories in your account yet'});
  await expect(note).toBeVisible();
  await expect(note.getByRole('link', {name: /Use the classic form/})).toHaveAttribute('href', '/repo/create?ui=classic');
  // The name is still checked as it is typed; the button says why it does not create.
  await page.getByRole('textbox', {name: 'Repository name'}).fill(`never-${RUN}`);
  await expect(page.getByText(`never-${RUN} is available.`)).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create repository'})).toHaveAttribute('aria-disabled', 'true');
  await page.goto(`${BASE}/org/create`);
  await expect(page.getByRole('note').filter({hasText: 'Forgejo Next cannot create organizations yet'})).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
  await api('DELETE', `/repos/${ORG}/in-org`);
  await api('DELETE', `/orgs/${ORG}`);
});

test('a new repository: from the account menu, the name checked, initialized, its home opens', async ({browser}) => {
  test.skip(!await canCreate(), NO_SCOPE);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await ok(await api('POST', '/user/repos', {name: `taken-${RUN}`}), 'a repository to collide with');

  await sidebar(page).getByRole('button', {name: USER}).first().click();
  await page.getByRole('menuitem', {name: 'New repository'}).click();
  await expect(page).toHaveURL(`${BASE}/repo/create`);
  await expect(page.getByRole('heading', {name: 'Create a new repository'})).toBeVisible();

  const name = page.getByRole('textbox', {name: 'Repository name'});
  await name.fill('has space');
  await expect(page.getByRole('alert').filter({hasText: 'Try “has-space”'})).toBeVisible();
  await name.fill(`taken-${RUN}`);
  await expect(page.getByRole('alert').filter({hasText: 'already has a repository'})).toBeVisible();
  await name.fill(REPO);
  await expect(page.getByText(`${REPO} is available.`)).toBeVisible();

  await page.getByRole('textbox', {name: 'Description'}).fill('Made in Forgejo Next.');
  await page.getByRole('radio', {name: /Private/}).check();
  await page.getByRole('button', {name: 'Choose a license'}).click();
  await page.getByRole('combobox').fill('MIT');
  await page.getByRole('option', {name: 'MIT', exact: true}).click();
  await expect(page.getByRole('checkbox', {name: 'Add a README file'})).toBeChecked();
  await page.getByRole('button', {name: 'Create repository'}).click();

  await expect(page).toHaveURL(`${BASE}/${USER}/${REPO}`, {timeout: 30_000});
  await expect(page.getByText('Made in Forgejo Next.').first()).toBeVisible({timeout: 30_000});
  const made = await apiJson<{private: boolean; empty: boolean}>('GET', `/repos/${USER}/${REPO}`);
  expect(made.private).toBe(true);
  expect(made.empty).toBe(false);
  const license = await api('GET', `/repos/${USER}/${REPO}/contents/LICENSE`);
  expect(license.status).toBe(200);
  await api('DELETE', `/repos/${USER}/taken-${RUN}`);
  expect(problems).toEqual([]);
  await ctx.close();
});

test('a new organization, then a repository in it from its page (?org= picks the owner)', async ({browser}) => {
  test.skip(!await canCreate(), NO_SCOPE);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/org/create`);
  await expect(page.getByRole('heading', {name: 'Create a new organization'})).toBeVisible();
  const name = page.getByRole('textbox', {name: 'Organization name'});
  await name.fill('repo');
  await expect(page.getByRole('alert').filter({hasText: 'reserved'})).toBeVisible();
  await name.fill(USER);
  await expect(page.getByRole('alert').filter({hasText: 'is taken'})).toBeVisible();
  await name.fill(ORG);
  await page.getByRole('radio', {name: /Limited/}).check();
  await page.getByRole('button', {name: 'Create organization'}).click();
  await expect(page).toHaveURL(`${BASE}/${ORG}`, {timeout: 30_000});
  const org = await apiJson<{visibility: string}>('GET', `/orgs/${ORG}`);
  expect(org.visibility).toBe('limited');

  await page.getByRole('link', {name: 'New repository'}).click();
  await expect(page).toHaveURL(/\/repo\/create\?org=\d+$/);
  await expect(page.getByRole('button', {name: 'Owner'})).toContainText(ORG, {timeout: 20_000});
  await page.getByRole('textbox', {name: 'Repository name'}).fill('in-org');
  await page.getByRole('button', {name: 'Create repository'}).click();
  await expect(page).toHaveURL(`${BASE}/${ORG}/in-org`, {timeout: 30_000});
  expect(problems).toEqual([]);
  await ctx.close();
});

test('offline, the forms say why they cannot create', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/repo/create`);
  await page.getByRole('textbox', {name: 'Repository name'}).fill(`never-${RUN}`);
  await ctx.setOffline(true);
  await expect(page.getByText('Offline: creating a repository needs a connection.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create repository'})).toHaveAttribute('aria-disabled', 'true');
  // Enter submits the form: nothing is sent (or queued).
  await page.getByRole('textbox', {name: 'Repository name'}).press('Enter');
  await ctx.setOffline(false);
  expect((await api('GET', `/repos/${USER}/never-${RUN}`)).status).toBe(404);
  await ctx.close();
});
