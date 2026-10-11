// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, ok} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const REPO = `templates-${Date.now().toString(36)}`;
const path = `/repos/${USER}/${REPO}`;

test.beforeAll(async () => {
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true}), 'seed template repository');
  await ok(await api('POST', `${path}/labels`, {name: 'bug', color: 'd73a4a'}), 'seed label');
  const files = {
    'config.yml': 'blank_issues_enabled: false\ncontact_links:\n  - name: Support\n    url: https://example.org/support\n    about: Ask for help\n',
    'bug.md': `---\nname: Bug report\nabout: Describe a bug\ntitle: "[Bug] "\nlabels: bug\nassignees: ${USER}\n---\n## What happened?\n\nDescribe the problem.\n`,
    'form.yaml': `name: Structured report\nabout: Required fields\ntitle: "[Form] "\nbody:\n  - type: markdown\n    attributes:\n      value: Please complete the report.\n  - type: input\n    id: version\n    attributes:\n      label: Version\n    validations:\n      required: true\n  - type: textarea\n    id: details\n    attributes:\n      label: Details\n  - type: dropdown\n    id: platform\n    attributes:\n      label: Platform\n      options: [Linux, macOS]\n    validations:\n      required: true\n  - type: checkboxes\n    id: confirm\n    attributes:\n      label: Confirmation\n      options:\n        - label: I searched existing issues\n          required: true\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    await ok(await api('POST', `${path}/contents/.forgejo/ISSUE_TEMPLATE/${name}`, {content: Buffer.from(content).toString('base64'), message: `Add ${name}`}), `seed ${name}`);
  }
});

test.afterAll(async () => { await api('DELETE', path); });

test('chooser, markdown defaults, required forms, direct links and cached offline creation', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await page.getByRole('button', {name: 'New issue', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'New issue'});
  await expect(dialog.getByRole('option', {name: /Bug report/})).toBeVisible();
  await expect(dialog.getByRole('option', {name: 'Blank issue'})).toHaveCount(0);
  await expect(dialog.getByRole('link', {name: /Support/})).toHaveAttribute('target', '_blank');
  await dialog.getByRole('option', {name: /Bug report/}).click();
  await expect(dialog.getByRole('textbox', {name: 'Title'})).toHaveValue('[Bug] ');
  await dialog.getByRole('textbox', {name: 'Title'}).fill('[Bug] Template defaults');
  await dialog.getByRole('button', {name: 'Create issue'}).click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/issues/\\d+$`), {timeout: 30_000});
  const number = page.url().split('/').at(-1) ?? '';
  const made = await apiJson<{body: string; labels: {name: string}[]; assignees: {login: string}[]}>('GET', `${path}/issues/${number}`);
  expect(made.body).toContain('## What happened?');
  expect(made.labels.map((l) => l.name)).toContain('bug');
  expect(made.assignees.map((u) => u.login)).toContain(USER);

  await page.goto(`${BASE}/${USER}/${REPO}/issues/new?template=form.yaml`);
  await expect(dialog.getByRole('textbox', {name: 'Version'})).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Title'}).fill('[Form] Offline report');
  await dialog.getByRole('button', {name: 'Create issue'}).click();
  await expect(dialog.getByText('Complete this required field.')).toHaveCount(3);
  await dialog.getByRole('textbox', {name: 'Version'}).fill('2.0');
  await dialog.getByRole('combobox', {name: 'Platform'}).selectOption({label: 'Linux'});
  await dialog.getByRole('checkbox', {name: 'I searched existing issues'}).check();
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await ctx.setOffline(true);
  await page.getByRole('button', {name: 'New issue', exact: true}).click();
  await expect(dialog.getByRole('textbox', {name: 'Version'})).toHaveValue('2.0');
  await dialog.getByRole('button', {name: 'Create issue'}).click();
  await expect(page).toHaveURL(/\/issues\/new-[\da-f-]+$/);
  await ctx.setOffline(false);
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/issues/\\d+$`), {timeout: 30_000});
  const form = await apiJson<{body: string}>('GET', `${path}/issues/${page.url().split('/').at(-1) ?? ''}`);
  expect(form.body).toBe('### Version\n\n2.0\n\n### Details\n\n_No response_\n\n### Platform\n\nLinux\n\n### Confirmation\n\n- [x] I searched existing issues\n\n');
  expect(problems).toEqual([]);
  await ctx.close();
});
