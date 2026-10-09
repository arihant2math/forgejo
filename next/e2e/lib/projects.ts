// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Project boards through the classic UI (API v1 has no projects API): the
// form Forgejo's own pages post, with the page's session cookies.

import {expect, type Page} from '@playwright/test';
import {BASE} from './env.ts';

/** Creates a project with the basic kanban columns and puts issues on it; returns its id. `page` is signed in to Forgejo. */
export async function classicProject(page: Page, owner: string, repo: string, title: string, issues: {id: number}[]): Promise<number> {
  await page.goto(`${BASE}/${owner}/${repo}/projects`);
  const id = await page.evaluate(async ({owner, repo, title, ids}) => {
    const form = new URLSearchParams({title, content: '', template_type: 'basic_kanban', card_type: 'text_only'});
    const res = await fetch(`/${owner}/${repo}/projects/new`, {method: 'POST', body: form, redirect: 'manual'});
    if (res.status >= 400) throw new Error(`create project: ${String(res.status)}`);
    const html = await (await fetch(`/${owner}/${repo}/projects`)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const link = [...doc.querySelectorAll<HTMLAnchorElement>(`a[href*="/${owner}/${repo}/projects/"]`)].find((a) => a.textContent.trim() === title);
    const pid = Number(/projects\/(\d+)/.exec(link?.getAttribute('href') ?? '')?.[1]);
    const add = await fetch(`/${owner}/${repo}/issues/projects`, {method: 'POST', body: new URLSearchParams({id: String(pid), issue_ids: ids.join(',')})});
    if (add.status >= 400) throw new Error(`add to project: ${String(add.status)}`);
    return pid;
  }, {owner, repo, title, ids: issues.map((i) => i.id)});
  expect(id).toBeGreaterThan(0);
  return id;
}

/** The column (title) an issue's card is in on the classic project page. */
export async function classicColumn(page: Page, owner: string, repo: string, projectId: number, issue: {number: number}): Promise<string | undefined> {
  const html = await (await page.request.get(`${BASE}/${owner}/${repo}/projects/${String(projectId)}`)).text();
  for (const chunk of html.split('class="project-column"').slice(1)) {
    if (chunk.includes(`/issues/${String(issue.number)}"`)) return /class="project-column-title-label">([^<]*)</.exec(chunk)?.[1]?.trim();
  }
  return undefined;
}
