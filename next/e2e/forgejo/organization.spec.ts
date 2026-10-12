// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, ok} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const ORG = `teams-${Date.now().toString(36)}`;

test('organization labels, team membership and repository access stay in-app', async ({browser}) => {
  await ok(await api('POST', '/orgs', {username: ORG, visibility: 'public'}), 'create organization');
  const team = await apiJson<{id: number}>('POST', `/orgs/${ORG}/teams`, {name: 'triage', permission: 'read', units: ['repo.issues']});
  await ok(await api('POST', `/orgs/${ORG}/repos`, {name: 'notes', auto_init: true}), 'create repository');
  const ctx = await browser.newContext();
  try {
    const page = await signedIn(ctx);
    const problems = watch(page);
    await page.goto(`${BASE}/${ORG}`);
    await page.getByRole('button', {name: 'More of this organization'}).click();
    await page.getByRole('menuitem', {name: 'Labels', exact: true}).click();
    await page.getByRole('button', {name: 'New organization label'}).click();
    await page.getByRole('textbox', {name: 'Name', exact: true}).fill('needs-triage');
    await page.getByRole('button', {name: 'Create label', exact: true}).click();
    await expect(page.getByText('needs-triage', {exact: true})).toBeVisible();
    const labels = await apiJson<{id: number; name: string}[]>('GET', `/orgs/${ORG}/labels`);
    expect(labels.some((l) => l.name === 'needs-triage')).toBe(true);
    await page.getByRole('button', {name: 'Edit organization label needs-triage'}).click();
    await page.getByRole('textbox', {name: 'Name', exact: true}).fill('triaged');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(page.getByText('triaged', {exact: true})).toBeVisible();
    expect((await apiJson<{name: string}[]>('GET', `/orgs/${ORG}/labels`)).some((l) => l.name === 'triaged')).toBe(true);
    await page.getByRole('button', {name: 'Delete organization label triaged'}).click();
    await page.getByRole('button', {name: 'Delete label', exact: true}).click();
    await expect(page.getByText('triaged', {exact: true})).toHaveCount(0);
    expect(await apiJson<unknown[]>('GET', `/orgs/${ORG}/labels`)).toEqual([]);
    await page.getByRole('dialog', {name: `Labels of ${ORG}`}).getByRole('button', {name: 'Close'}).click();

    await page.getByRole('link', {name: 'Teams', exact: true}).click();
    await page.getByRole('button', {name: 'Members of triage', exact: true}).click();
    await page.getByRole('button', {name: 'Add member', exact: true}).click();
    await page.getByRole('combobox').fill(USER);
    await page.getByRole('option').filter({hasText: USER}).first().click();
    await expect(page.getByRole('button', {name: `Remove ${USER} from team`})).toBeVisible();
    const members = await apiJson<{login: string}[]>('GET', `/teams/${team.id}/members`);
    expect(members.some((u) => u.login === USER)).toBe(true);

    await page.goto(`${BASE}/${ORG}/notes/settings/collaboration`);
    await page.getByRole('button', {name: 'Add team', exact: true}).click();
    await page.getByRole('option', {name: 'triage'}).click();
    await expect(page.getByRole('button', {name: 'Remove team triage'})).toBeVisible();
    const teams = await apiJson<{id: number}[]>('GET', `/repos/${ORG}/notes/teams`);
    expect(teams.some((t) => t.id === team.id)).toBe(true);
    await page.getByRole('button', {name: 'Remove team triage'}).click();
    await expect(page.getByRole('button', {name: 'Remove team triage'})).toHaveCount(0);
    expect((await apiJson<{id: number}[]>('GET', `/repos/${ORG}/notes/teams`)).some((t) => t.id === team.id)).toBe(false);
    await page.goto(`${BASE}/${ORG}`);
    await page.getByRole('link', {name: 'Teams', exact: true}).click();
    await page.getByRole('button', {name: 'Members of triage'}).click();
    await page.getByRole('button', {name: `Remove ${USER} from team`}).click();
    await expect(page.getByRole('button', {name: `Remove ${USER} from team`})).toHaveCount(0);
    expect(await apiJson<unknown[]>('GET', `/teams/${team.id}/members`)).toEqual([]);
    expect(problems).toEqual([]);
  } finally {
    await ctx.close();
    await api('DELETE', `/repos/${ORG}/notes`);
    await api('DELETE', `/orgs/${ORG}`);
  }
});
