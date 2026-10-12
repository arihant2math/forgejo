// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {EditorView} from '@codemirror/view';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {type App as AppState, createApp, type Session} from '../../app/store.ts';
import type {Intent} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import {IntentDb} from '../../intents/store.ts';
import type {Label, NextConfig} from '../../protocol/types.gen.ts';
import {comment, fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  // jsdom has no layout: record what is scrolled into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', {status: 404}))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function session(permission: string, comments = 0) {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'member'}]}});
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission});
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken', {poster_id: 3, comments}));
  for (let i = 1; i <= comments; i++) {
    const at = new Date(Date.parse(T) + i * 60_000).toISOString();
    s.data.put('Comment', 'issue:100', comment(1000 + i, 100, `Comment number ${String(i)}`, {poster_id: 3, created_at: at, updated_at: at}));
  }
  return s;
}

async function open(path: string, s: Session) {
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  await screen.findByRole('heading', {level: 1, name: /Footer links are broken/});
  return {app, router};
}

test('a writer who is not an administrator can lock but not pin (#226)', async () => {
  await open('/acme/website/issues/7', session('write'));
  expect(await screen.findByRole('button', {name: 'Lock conversation'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Pin issue/})).toBeNull();
});

test('locking asks for one of Forgejo\'s reasons in a dialog, then queues the lock', async () => {
  const {app} = await open('/acme/website/issues/7', session('write'));
  fireEvent.click(await screen.findByRole('button', {name: 'Lock conversation'}));
  const dialog = await screen.findByRole('dialog', {name: 'Lock conversation on this issue'});
  const lock = within(dialog).getByRole('button', {name: 'Lock conversation on this issue'});
  fireEvent.click(lock);
  expect(queued(app).some((intent) => intent.kind === 'issue.lock')).toBe(false);
  fireEvent.change(within(dialog).getByRole('combobox', {name: /Reason/}), {target: {value: 'Resolved'}});
  fireEvent.click(lock);
  expect(queued(app)).toContainEqual(expect.objectContaining({kind: 'issue.lock', issueId: 100, locked: true, reason: 'Resolved'}));
});

test('notifications: the button says what it does, and a line says why', async () => {
  const s = session('read');
  s.data.put('IssueWatch', 'user:1', {id: 1, issue_id: 100, user_id: 1, is_watching: true, created_at: T, updated_at: T} as never);
  await open('/acme/website/issues/7', s);
  const sidebar = screen.getByRole('complementary', {name: 'Properties'});
  const section = within(sidebar).getByRole('heading', {name: 'Notifications'}).closest('section');
  if (!(section instanceof HTMLElement)) throw new Error('no notifications section');
  expect(within(section).getByRole('button').textContent).toMatch(/^(Subscribe|Unsubscribe)$/);
  expect(section.textContent).toMatch(/You’re (receiving|not receiving) notifications/);
});

test('sidebar identities keep the reference 20px avatar and medium (14px) name', async () => {
  const s = session('read');
  s.data.put('User', 'profile:1', {...user(1, 'alice'), full_name: 'Alice Martin', avatar_url: '/avatars/alice.png'});
  s.data.put('IssueAssignee', 'repo:20', {id: 1, issue_id: 100, assignee_id: 1});
  await open('/acme/website/issues/7', s);
  const sidebar = screen.getByRole('complementary', {name: 'Properties'});
  const avatar = within(sidebar).getByRole('img', {name: 'Alice Martin'});
  expect(avatar.getAttribute('width')).toBe('20');
  expect(avatar.getAttribute('height')).toBe('20');
  const name = within(sidebar).getByText('Alice Martin');
  expect(name.getAttribute('data-component')).toBe('Text');
  expect(name.getAttribute('data-size')).toBe('medium');
});

test('an administrator can pin (#226)', async () => {
  await open('/acme/website/issues/7', session('admin'));
  expect(await screen.findByRole('button', {name: 'Pin issue'})).toBeTruthy();
});

test('a comment permalink scrolls to the comment and highlights it, also past the first painted items (#210)', async () => {
  await open('/acme/website/issues/7#comment-1025', session('read', 30));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1025');
  });
  const card = document.getElementById('comment-1025');
  expect(card?.getAttribute('aria-current')).toBe('location');
  expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
});

test('classic Forgejo\'s #issuecomment- permalinks work too, and an unknown comment scrolls nowhere (#210)', async () => {
  await open('/acme/website/issues/7#issuecomment-1003', session('read', 5));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1003');
  });
  cleanup();
  scrolled = [];
  await open('/acme/website/issues/7#comment-999', session('read', 5));
  await screen.findByText('Comment number 5', {exact: false}).catch(() => undefined);
  expect(scrolled.filter((e) => e.id.startsWith('comment-'))).toEqual([]);
});

test('a comment draft kept in IndexedDB is back in the comment box even when the page opens before the drafts are read (#193)', async () => {
  const s = session('write');
  await new IntentDb(s.data.db).putDraft({key: 'text:new-comment:100', kind: 'text', title: 'A new comment', issueId: 100, repoId: 20, text: 'Half-written reply', at: Date.now()});
  await open('/acme/website/issues/7', s);
  await waitFor(() => {
    const box = screen.getByRole('textbox', {name: 'Leave a comment'});
    expect(box instanceof HTMLTextAreaElement ? box.value : box.textContent).toBe('Half-written reply');
  });
});

test('an empty comment cannot be submitted; typing enables submission and saving empties it again', async () => {
  const {app} = await open('/acme/website/issues/7', session('write'));
  const submit = screen.getByRole('button', {name: 'Comment'});
  expect(submit.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText('Enter text to save.')).toBeTruthy();
  fireEvent.click(submit);
  expect(queued(app)).toEqual([]);
  let view: EditorView | null = null;
  await waitFor(() => {
    view = EditorView.findFromDOM(screen.getByRole('textbox', {name: 'Leave a comment'}));
    expect(view).not.toBeNull();
  });
  act(() => { view?.dispatch({changes: {from: 0, insert: 'A reply'}}); });
  expect(submit.getAttribute('aria-disabled')).toBe('false');
  fireEvent.click(submit);
  expect(queued(app)).toContainEqual(expect.objectContaining({kind: 'comment.create', body: 'A reply'}));
  expect(submit.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(submit);
  expect(queued(app).filter((intent) => intent.kind === 'comment.create')).toHaveLength(1);
});

test.each(['e11d21', '#e11d21'])('labels with color %s remain readable and linked in the sidebar and timeline', async (color) => {
  const s = session('read', 1);
  s.data.put('Label', 'repo:20', {...label(1, 'bug'), exclusive: false, color});
  s.data.put('IssueLabel', 'repo:20', {id: 1, issue_id: 100, label_id: 1});
  s.data.put('Comment', 'issue:100', comment(1001, 100, '1', {type: 'label', label_id: 1}));
  await open('/acme/website/issues/7', s);
  const sidebar = screen.getByRole('complementary', {name: 'Properties'});
  expect(within(sidebar).getByRole('link', {name: 'bug'}).getAttribute('href')).toBe('/acme/website/issues?labels=1');
  await waitFor(() => {
    expect(screen.getAllByRole('link', {name: 'bug'})).toHaveLength(2);
    expect(screen.getByText('added', {exact: false})).toBeTruthy();
  });
});

test('a long (virtualized) timeline brings the linked comment into view (#210)', async () => {
  await open('/acme/website/issues/7#comment-1055', session('read', 60));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1055');
  }, {timeout: 4000});
});

function label(id: number, name: string): Label {
  return {id, repo_id: 20, org_id: 0, name, exclusive: true, description: '', color: '888888', num_issues: 0, num_closed_issues: 0, created_at: T};
}

function queued(app: AppState): Intent[] {
  return [...editing(app).intents.records.values()].map((r) => r.intent);
}

test('an open issue closes as a duplicate of another: the comment, the duplicate status and the close (#216)', async () => {
  const s = session('write');
  s.data.put('Issue', 'repo:20', issue(101, 20, 5, 'Footer links 404', {poster_id: 3}));
  s.data.put('Label', 'repo:20', label(1, 'status/Todo'));
  s.data.put('Label', 'repo:20', label(2, 'status/Canceled'));
  s.data.put('Label', 'repo:20', label(3, 'status/Duplicate'));
  const {app} = await open('/acme/website/issues/7', s);
  fireEvent.click(screen.getByRole('button', {name: 'Choose a close reason'}));
  fireEvent.click(await screen.findByRole('menuitemradio', {name: /Close as duplicate/}));
  const field = await screen.findByRole('combobox', {name: /Duplicate of/});
  fireEvent.change(field, {target: {value: '5'}});
  fireEvent.click(await screen.findByRole('option', {name: /#5 Footer links 404/}));
  const intents = queued(app);
  expect(intents).toContainEqual(expect.objectContaining({kind: 'comment.create', issueId: 100, body: 'Duplicate of #5'}));
  expect(intents).toContainEqual(expect.objectContaining({kind: 'issue.label', issueId: 100, labelId: 3, add: true}));
  expect(intents).toContainEqual(expect.objectContaining({kind: 'issue.state', issueId: 100, state: 'closed'}));
});

test('close is a split button: not planned renames it and sets the canceled status; offered only when the repository has one (#216)', async () => {
  const s = session('write');
  s.data.put('Label', 'repo:20', label(2, 'status/Canceled'));
  const {app} = await open('/acme/website/issues/7', s);
  expect(screen.getByRole('button', {name: 'Close issue'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Choose a close reason'}));
  fireEvent.click(await screen.findByRole('menuitemradio', {name: /Close as not planned/}));
  expect(queued(app)).toEqual([]);
  fireEvent.click(await screen.findByRole('button', {name: 'Close as not planned'}));
  expect(queued(app)).toContainEqual(expect.objectContaining({kind: 'issue.label', issueId: 100, labelId: 2, add: true}));
  expect(queued(app)).toContainEqual(expect.objectContaining({kind: 'issue.state', issueId: 100, state: 'closed'}));
  cleanup();
  await open('/acme/website/issues/7', session('write'));
  fireEvent.click(screen.getByRole('button', {name: 'Choose a close reason'}));
  expect(await screen.findByRole('menuitemradio', {name: /Close as completed/})).toBeTruthy();
  expect(screen.queryByRole('menuitemradio', {name: /Close as not planned/})).toBeNull();
});

test('on a wide page the properties are a scroll region of their own, bounded by the page body (#273)', async () => {
  await open('/acme/website/issues/7', session('write'));
  const pane = screen.getByRole('complementary', {name: 'Properties'});
  const body = pane.closest('[data-scroll-restoration-id="page"]');
  expect(body?.classList.contains('overflow-y-auto')).toBe(true);
  // jsdom cannot measure sticky layout; the browser test covers geometry.
  expect(body?.classList.contains('@container-size')).toBe(true);
  const scroller = pane.firstElementChild;
  for (const c of ['@xl:sticky', '@xl:top-0', '@xl:max-h-page-body', '@xl:overflow-y-auto', '@xl:overscroll-contain']) expect(scroller?.classList.contains(c), c).toBe(true);
  expect(within(pane).getByRole('button', {name: 'Lock conversation'})).toBeTruthy();
});

test('the timeline gives state changes GitHub\'s coloured badges and condenses other events', async () => {
  const s = session('read');
  s.data.put('Label', 'repo:20', {...label(1, 'bug'), exclusive: false});
  s.data.put('Comment', 'issue:100', comment(1001, 100, '1', {type: 'label', label_id: 1}));
  s.data.put('Comment', 'issue:100', comment(1002, 100, '', {type: 'close', created_at: '2026-02-01T00:00:00Z'}));
  s.data.put('Comment', 'issue:100', comment(1003, 100, '', {type: 'reopen', created_at: '2026-02-02T00:00:00Z'}));
  await open('/acme/website/issues/7', s);
  const activity = await screen.findByRole('region', {name: 'Activity'});
  await waitFor(() => {
    expect(activity.querySelector('[data-variant="done"] .octicon-issue-closed')).not.toBeNull();
  });
  expect(activity.querySelector('[data-variant="open"] .octicon-issue-reopened')).not.toBeNull();
  const labelled = within(activity).getByText('added', {exact: false}).closest('.Timeline-Item');
  expect(labelled?.hasAttribute('data-condensed')).toBe(true);
});

test('the description is the conversation\'s first card, with the comment menu in GitHub\'s order', async () => {
  const s = session('write', 1);
  s.data.put('IssueBody', 'issue:100', {id: 100, repo_id: 20, body: 'Steps to reproduce', body_html: '<p>Steps to reproduce</p>', content_version: 0});
  await open('/acme/website/issues/7', s);
  const description = (await screen.findByText('Steps to reproduce')).closest('article');
  expect(description?.textContent).toContain('opened');
  if (!description) throw new Error('no description card');
  fireEvent.click(within(description).getByRole('button', {name: 'Description actions'}));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Copy link', 'Quote reply', 'Edit']);
  fireEvent.keyDown(document.activeElement ?? document.body, {key: 'Escape'});
  const card = document.getElementById('comment-1001');
  if (!card) throw new Error('no comment card');
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  fireEvent.click(within(card).getByRole('button', {name: 'Comment actions'}));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Copy link', 'Quote reply', 'Edit', 'Delete…']);
});
