// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {expect, test} from '@playwright/test';
import {api, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {codeUrl} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test('create nested file, upload two files, delete file and folder in single commits', async ({page}) => {
  const repo = `file-operations-${Date.now().toString(36)}`;
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repository');
  const commit = async () => {
    await page.getByRole('button', {name: 'Commit changes…', exact: true}).click();
    await page.getByRole('dialog', {name: 'Commit changes'}).getByRole('button', {name: 'Commit changes', exact: true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  const contents = async (path: string) => (await ok(await api('GET', `/repos/${USER}/${repo}/contents/${path}?ref=main`), 'read content')).json() as Promise<{content: string}>;
  try {
    await signIn(page);
    await page.goto(codeUrl(repo, 'src/branch/main'));
    await page.getByRole('button', {name: 'Add file', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Create new file'}).click();
    await page.getByRole('textbox', {name: 'File path'}).fill('docs/new.txt');
    await page.getByRole('textbox', {name: 'File contents'}).fill('A new file\n');
    await commit();
    expect(Buffer.from((await contents('docs/new.txt')).content, 'base64').toString()).toBe('A new file\n');
    await page.goto(codeUrl(repo, 'src/branch/main/docs'));
    await page.getByRole('button', {name: 'Add file', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Upload files'}).click();
    await page.getByLabel('Choose files', {exact: true}).setInputFiles([
      {name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one')},
      {name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two')},
    ]);
    await commit();
    expect(Buffer.from((await contents('docs/one.txt')).content, 'base64').toString()).toBe('one');
    expect(Buffer.from((await contents('docs/two.txt')).content, 'base64').toString()).toBe('two');
    await page.goto(codeUrl(repo, 'src/branch/main/docs/one.txt'));
    await page.getByRole('button', {name: 'Add file', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Delete file', exact: true}).click();
    await page.getByRole('dialog', {name: 'Commit changes'}).getByRole('button', {name: 'Commit changes', exact: true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api('GET', `/repos/${USER}/${repo}/contents/docs/one.txt?ref=main`)).status).toBe(404);
    await page.goto(codeUrl(repo, 'src/branch/main/docs'));
    await page.getByRole('button', {name: 'Add file', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Delete folder', exact: true}).click();
    await page.getByRole('dialog', {name: 'Commit changes'}).getByRole('button', {name: 'Commit changes', exact: true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api('GET', `/repos/${USER}/${repo}/contents/docs/two.txt?ref=main`)).status).toBe(404);
  } finally {await api('DELETE', `/repos/${USER}/${repo}`);}
});
