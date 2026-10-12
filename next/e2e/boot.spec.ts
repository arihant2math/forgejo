// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The boot shell of the production build: the splash state is applied before
// first paint, by the inline script alone, and the app then boots without a
// CSS request.

import {expect, test, type Page} from '@playwright/test';

const darkCanvas = 'rgb(1, 4, 9)'; // Primer --bgColor-inset, dark
const lightCanvas = 'rgb(246, 248, 250)';

async function seed(page: Page, splash: object) {
  await page.addInitScript((s) => {
    localStorage.setItem('splash', s);
  }, JSON.stringify(splash));
}

/** Records <html data-theme> and the page background at the first animation frame. */
async function recordFirstFrame(page: Page) {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const html = document.documentElement;
      (window as unknown as {firstFrame: object}).firstFrame = {
        theme: html.dataset.theme,
        background: getComputedStyle(html).backgroundColor,
        hasBody: Boolean(document.body),
      };
    });
  });
}

test('stored splash is applied by the inline script alone (app JS blocked)', async ({page}) => {
  await page.route('**/assets/*.js', (route) => route.abort());
  await seed(page, {theme: 'dark', user: '1', sidebarWidth: 300, skeleton: {shape: 'list', rows: 5}, initial: 'A'});
  await page.goto('/-/next/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-shell', 'app');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(darkCanvas);
  expect((await page.locator('aside').boundingBox())?.width).toBe(300);
  await expect(page.locator('[data-sk-row]:visible')).toHaveCount(5);
  await expect(page.getByText(/^Sign in to continue\./)).toBeHidden();
  // Account metadata is private and not loaded by the static shell; Primer reserves an avatar's place.
  await expect(page.locator('aside [data-component="SkeletonAvatar"]').first()).toBeVisible();
});

test('the first frame already has the stored theme', async ({page}) => {
  await recordFirstFrame(page);
  await seed(page, {theme: 'dark', user: '1'});
  await page.goto('/-/next/');
  await page.waitForFunction(() => 'firstFrame' in window);
  expect(await page.evaluate(() => (window as unknown as {firstFrame: object}).firstFrame)).toEqual({
    theme: 'dark', background: darkCanvas, hasBody: true,
  });
});

test('detail skeleton shape', async ({page}) => {
  await page.route('**/assets/*.js', (route) => route.abort());
  await seed(page, {user: '1', skeleton: {shape: 'detail'}});
  await page.goto('/-/next/');
  await expect(page.locator('[data-sk-row]:visible')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-skeleton', 'detail');
});

test('a repository page\'s header rows: breadcrumb, then its tabs, then its title row', async ({page}) => {
  await page.route('**/assets/*.js', (route) => route.abort());
  const header = page.getByRole('main').locator('header');
  // One row of the header's height each (--spacing-header).
  const rows = async (splash: object) => {
    await seed(page, {user: '1', ...splash});
    await page.goto('/-/next/');
    return Math.round(((await header.boundingBox())?.height ?? 0) / 48);
  };
  expect(await rows({skeleton: {shape: 'list'}})).toBe(1);
  expect(await rows({skeleton: {shape: 'detail', header: 'tabs'}})).toBe(2);
  expect(await rows({skeleton: {shape: 'list', header: 'toolbar'}})).toBe(3);
});

test('system theme follows the OS when nothing is stored', async ({page}) => {
  await page.emulateMedia({colorScheme: 'dark'});
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/-/next/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('no local DB marker: logged-out shell, then the app boots from preloaded chunks without CSS requests', async ({page}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/-/next/');
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'logged-out');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(lightCanvas);
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByName('appStart').length)).toBe(1);

  const preloads = await page.locator('link[rel=modulepreload]').evaluateAll((ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname));
  const scripts = requests.filter((p) => p.endsWith('.js'));
  // Every script the boot fetched was announced in the HTML (no late discovery).
  const entry = await page.locator('script[type=module]').getAttribute('src');
  for (const s of scripts) expect([...preloads, entry]).toContain(s);
  expect(preloads.some((p) => /\/Home-[\w-]+\.js$/.test(p))).toBe(true);
  expect(requests.filter((p) => p.endsWith('.css'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('React replaces the logged-out boot shell without moving anything', async ({browser}) => {
  // React's commit inserts new nodes, which the layout-shift API ignores, so
  // compare positions: the static shell (app JS blocked) against the mounted app.
  const boxes = async (blockJs: boolean) => {
    const page = await browser.newPage();
    if (blockJs) await page.route('**/assets/*.js', (route) => route.abort());
    await page.goto('/-/next/');
    const mounted = page.locator('#root > :not(.logged-out\\:flex)');
    if (!blockJs) await expect(mounted.getByRole('button', {name: 'Sign in'})).toBeVisible();
    const scope = blockJs ? page.locator('.logged-out\\:flex') : mounted;
    const result = await Promise.all([
      scope.getByRole('button', {name: 'Sign in'}).boundingBox(),
      scope.getByText('Forgejo', {exact: true}).boundingBox(),
      scope.getByText(/^Sign in to continue\./).boundingBox(),
      scope.locator('svg').boundingBox(),
    ]);
    await page.close();
    return result;
  };
  const before = await boxes(true);
  expect(before.every(Boolean)).toBe(true);
  expect(await boxes(false)).toEqual(before);
});

test('a boot chunk that keeps failing: one reload, then a reload screen', async ({page}) => {
  let attempts = 0;
  await page.route('**/assets/Home-*.js', (route) => {
    attempts++;
    return route.abort();
  });
  page.on('console', () => undefined);
  await page.goto('/-/next/');
  await expect(page.getByRole('button', {name: 'Reload'})).toBeVisible();
  await expect(page.getByText('Forgejo could not load')).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2); // the first load and the automatic reload
});

test('text renders in the bundled fonts, served with the app, not in system fonts (#275)', async ({page}) => {
  const fonts: string[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.woff2')) fonts.push(`${String(r.status())} ${new URL(r.url()).pathname}`);
  });
  await page.goto('/-/next/');
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  // The UI's main face is preloaded by the shell.
  const preload = await page.locator('link[rel=preload][as=font]').evaluateAll((ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname));
  expect(preload).toEqual([expect.stringMatching(/^\/-\/next\/assets\/mona-sans-latin-wght-normal-[\w-]+\.woff2$/)]);

  // Prose, a heading, controls, italic, other scripts and code, inline and in a portal-like layer on <body>.
  await page.evaluate(() => {
    // The app's own Sign in button: the element holding its label's text (fonts are reported for a node's own text).
    const label = [...document.querySelectorAll('button *')].find((e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent === 'Sign in'));
    label?.setAttribute('id', 'f-signin');
    const layer = document.createElement('div');
    layer.innerHTML = `<h2 id="f-heading">Inbox</h2><p id="f-text">Notifications ąő ự</p><em id="f-italic">Italic text</em>
      <p id="f-cyrillic">Уведомления Ελληνικά नमस्ते</p><button id="f-button">Mark as read</button><textarea id="f-textarea">Reply</textarea>
      <code id="f-code">const x = 1; // ok</code><pre id="f-pre">fn main() { Ж }</pre><kbd id="f-kbd">Ctrl</kbd>`;
    document.body.append(layer);
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  // With user-agent shadow roots: a control's text is in its own (a textarea's value).
  const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
  type Node = typeof root;
  const find = (n: Node, id: string): Node | undefined => (n.attributes?.join(' ').includes(`id f-${id}`) ? n
    : [...n.children ?? [], ...n.shadowRoots ?? []].map((c) => find(c, id)).find(Boolean));
  const rendered = async (id: string) => {
    const el = find(root, id);
    const nodeId = el?.shadowRoots?.[0]?.children?.[0]?.nodeId ?? el?.nodeId ?? 0;
    const {fonts: used} = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
    // A variable font reports its default instance's name ("Mona Sans ExtraLight"): the family is what counts.
    const family = (name: string) => ['Mona Sans', 'Noto Sans', 'Source Code Pro'].find((f) => name.startsWith(f)) ?? name;
    return [...new Set(used.map((f) => `${family(f.familyName)}${f.isCustomFont ? '' : ' (system)'}`))].sort();
  };
  const sans = ['Mona Sans'];
  for (const id of ['signin', 'heading', 'text', 'italic', 'button', 'textarea']) expect(await rendered(id), id).toEqual(sans);
  expect(await rendered('cyrillic')).toEqual(['Mona Sans', 'Noto Sans']); // the spaces are Mona Sans'
  for (const id of ['code', 'pre', 'kbd']) expect(await rendered(id), id).toEqual(['Source Code Pro']);

  // Every face came from the app's assets.
  expect(fonts.length).toBeGreaterThan(0);
  for (const f of fonts) expect(f).toMatch(/^200 \/-\/next\/assets\/(?:mona-sans|noto-sans|source-code-pro)-[\w-]+\.woff2$/);
});
