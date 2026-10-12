// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, type Page} from '@playwright/test';
import {api, apiJson, ok} from './api.ts';
import {BASE, USER} from './env.ts';

export function goFile(n: number): string {
  const out = ['package main', '', 'import "fmt"', ''];
  for (let i = 0; i < n; i++) out.push(`// f${String(i)} prints its number.\nfunc f${String(i)}() {\n\tfmt.Println("value", ${String(i)})\n}\n`);
  return out.join('\n');
}

export function tsFile(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`export const value${String(i)}: number = ${String(i)} * 2; // line ${String(i)}`);
  return `${out.join('\n')}\n`;
}

export async function changeFiles(repo: string, body: object, as?: string): Promise<void> {
  await ok(await api('POST', `/repos/${USER}/${repo}/contents`, body, as), 'contents');
}

export async function blobSha(repo: string, path: string, ref?: string): Promise<string> {
  return (await apiJson<{sha: string}>('GET', `/repos/${USER}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`)).sha;
}

export const codeUrl = (repo: string, rest: string) => `${BASE}/${USER}/${repo}/${rest}`;

export interface Pull {
  number: number;
  id: number;
  head: {sha: string};
  merge_base: string;
}

/** Opens the line composer from Pierre's gutter button (lines are in Shadow DOM). */
export async function commentOnLine(page: Page, text: string, name: string | RegExp, lineType?: 'change-deletion' | 'change-addition'): Promise<void> {
  // A click makes the line the cursor and the selection, which the button follows.
  await page.locator(lineType ? `[data-line][data-line-type="${lineType}"]` : '[data-line]').filter({hasText: text}).first().click();
  const button = page.getByRole('button', {name: /^Comment on /}).filter({visible: true}).first();
  await button.hover();
  await expect(button).toHaveAccessibleName(name);
  await button.click();
}

/** Clicks a crumb of the path trail, from its overflow menu when Primer folded it there. */
export async function openCrumb(page: Page, name: string): Promise<void> {
  const trail = page.getByRole('navigation', {name: 'Breadcrumbs'}).last();
  const crumb = trail.getByRole('link', {name, exact: true});
  const more = trail.getByRole('button', {name: /more breadcrumb items$/});
  // The trail renders after the file loads; wait for it (either the crumb or the overflow button) before deciding.
  await expect(crumb.or(more).first()).toBeVisible();
  if (!await crumb.isVisible()) await trail.getByRole('button', {name: /more breadcrumb items$/}).click();
  await crumb.click();
}
