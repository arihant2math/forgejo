import {expect, test} from '@playwright/test';
import {api, ok} from '../lib/api.ts';
import {signedIn} from '../lib/app.ts';
import {ALICE, BASE, basic} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('repository code search opens a matching line', async ({browser}) => {
  const repo = `code-search-${Date.now().toString(36)}`;
  const auth = basic(ALICE.user, ALICE.password);
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true}, auth), 'create repository');
  try {
    await ok(await api('POST', `/repos/${ALICE.user}/${repo}/contents/search.txt`, {content: Buffer.from('uniqueSearchSymbol95\n').toString('base64'), message: 'add searchable file'}, auth), 'create file');
    const ctx = await browser.newContext();
    try {
      const page = await signedIn(ctx);
      await page.goto(`${BASE}/${ALICE.user}/${repo}/src/branch/main`);
      await page.getByRole('button', {name: 'Search code', exact: true}).click();
      await page.getByRole('textbox', {name: 'Search code', exact: true}).fill('uniqueSearchSymbol95');
      await page.getByRole('option').filter({hasText: 'search.txt:1'}).click();
      await expect(page).toHaveURL(/\/src\/commit\/[0-9a-f]+\/search\.txt#L1$/);
      await expect(page.getByText('uniqueSearchSymbol95', {exact: true}).first()).toBeVisible();
    } finally { await ctx.close(); }
  } finally { await api('DELETE', `/repos/${ALICE.user}/${repo}`, undefined, auth); }
});
