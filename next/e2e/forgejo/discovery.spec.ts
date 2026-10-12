// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, ensureUser, ok} from '../lib/api.ts';
import {sidebar, signedIn, watch} from '../lib/app.ts';
import {ALICE, BASE, basic, USER} from '../lib/env.ts';

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

test('explore repository rows: hover underlines only the name, over one row surface; the selection keeps its colour', async ({browser}) => {
  const suffix = Date.now().toString(36);
  const names = [`hover-a-${suffix}`, `hover-b-${suffix}`];
  for (const name of names) {
    await ok(await api('POST', '/user/repos', {name, description: `Row hover check ${name}`, private: false}), `create ${name}`);
  }
  try {
    const ctx = await browser.newContext({viewport: {width: 1440, height: 900}});
    try {
      const page = await signedIn(ctx);
      const problems = watch(page);
      await page.goto(`${BASE}/explore/repos?q=${suffix}`);
      const rows = page.getByRole('listbox', {name: 'Search results'}).getByRole('option');
      await expect(rows).toHaveCount(2);
      const tokens = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement('div'));
        const resolve = (prop: 'color' | 'backgroundColor', token: string) => {
          probe.style[prop] = `var(${token})`;
          return getComputedStyle(probe)[prop];
        };
        const out = {
          accent: resolve('color', '--fgColor-accent'), muted: resolve('color', '--fgColor-muted'),
          hover: resolve('backgroundColor', '--control-transparent-bgColor-hover'), selected: resolve('backgroundColor', '--bgColor-accent-muted'),
        };
        probe.remove();
        return out;
      });
      const look = (row: ReturnType<typeof rows.nth>) => row.evaluate((a) => {
        const [, title, detail] = [...a.children];
        if (!title || !detail) throw new Error('a repository row has an icon, a name and a description');
        const styleOf = (e: Element) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return {color: s.color, decoration: s.textDecorationLine, box: [r.x, r.y, r.width, r.height]}; };
        return {
          row: {background: getComputedStyle(a).backgroundColor, decoration: getComputedStyle(a).textDecorationLine, height: a.getBoundingClientRect().height},
          title: styleOf(title),
          detail: styleOf(detail),
        };
      });
      const [selectedRow, row] = [rows.nth(0), rows.nth(1)];
      await expect(selectedRow).toHaveAttribute('aria-selected', 'true');
      await expect(row).toHaveAttribute('aria-selected', 'false');

      const rest = await look(row);
      expect(rest.row).toMatchObject({background: 'rgba(0, 0, 0, 0)', decoration: 'none'});
      expect(rest.title.decoration).toBe('none');

      // Guard against Primer's BaseStyles underline extending beneath the row's muted description.
      await row.locator(':scope > span').last().hover();
      const hovered = await look(row);
      expect(hovered.row).toMatchObject({background: tokens.hover, decoration: 'none', height: rest.row.height});
      expect(hovered.title).toMatchObject({color: tokens.accent, decoration: 'underline', box: rest.title.box});
      expect(hovered.detail).toMatchObject({color: tokens.muted, decoration: 'none', box: rest.detail.box});

      await selectedRow.hover();
      const selected = await look(selectedRow);
      expect(selected.row).toMatchObject({background: tokens.selected, decoration: 'none'});
      expect(selected.title).toMatchObject({color: tokens.accent, decoration: 'underline'});
      expect(selected.detail.decoration).toBe('none');

      await page.mouse.move(0, 0);
      expect(await look(row)).toEqual(rest);
      expect(problems).toEqual([]);
    } finally { await ctx.close(); }
  } finally {
    for (const name of names) await api('DELETE', `/repos/${USER}/${name}`);
  }
});
