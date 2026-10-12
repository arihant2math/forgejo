// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, render, screen, within} from '@testing-library/react';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {emptyText} from './MyWork.tsx';

beforeAll(() => {
  if (!('scrollTo' in Element.prototype)) Object.assign(Element.prototype, {scrollTo: () => undefined});
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

async function renderPulls(path: string, answer: (url: URL) => Promise<Response>) {
  const s = fakeSession({userId: 1});
  vi.spyOn(s.auth, 'token').mockResolvedValue('t');
  const sam = user(1, 'sam');
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', sam);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  s.data.put('Issue', 'repo:20', issue(107, 20, 107, 'Merged one', {is_pull: true, state: 'closed'}));
  s.data.put('Issue', 'repo:20', issue(111, 20, 111, 'Merged two', {is_pull: true, state: 'closed'}));
  const asked: URL[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
    asked.push(url);
    return answer(url);
  }));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return {asked};
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}}));

describe('My pull requests > Review requested', () => {
  test('online, Forgejo answers nothing open: the empty list does not say it needs a connection', async () => {
    const {asked} = await renderPulls('/pulls?type=review_requested', (url) => json(url.searchParams.get('state') === 'open' ? [] : [{id: 111}, {id: 107}]));
    expect(await screen.findByText('Nothing open is waiting for your review. Closed and merged pull requests are not listed here: choose All to see them.')).toBeTruthy();
    expect(screen.queryByText(/needs a connection/)).toBeNull();
    expect(screen.queryByText('Needs a connection')).toBeNull();
    expect(asked.some((u) => u.pathname.endsWith('/api/v1/repos/issues/search') && u.searchParams.get('review_requested') === 'true')).toBe(true);
  });

  test('Forgejo not answering: the list says it needs a connection', async () => {
    await renderPulls('/pulls?type=review_requested', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await screen.findByText('Needs a connection')).toBeTruthy();
    expect(screen.getByText(/Review requests are not kept on this device and Forgejo could not be asked/)).toBeTruthy();
  });

  test('state All or Closed, Forgejo answers nothing: the empty text fits the state (no "choose All")', async () => {
    await renderPulls('/pulls?type=review_requested&state=all', () => json([]));
    expect(await screen.findByText('Nothing is waiting for your review, open, closed or merged.')).toBeTruthy();
    expect(screen.queryByText(/choose All/)).toBeNull();
    expect(screen.queryByText(/needs a connection/i)).toBeNull();
    cleanup();
    await renderPulls('/pulls?type=review_requested&state=closed', () => json([]));
    expect(await screen.findByText('No closed or merged pull request is waiting for your review.')).toBeTruthy();
    expect(screen.queryByText(/choose All/)).toBeNull();
  });

  test('state All, Forgejo not answering: it needs a connection (not "nothing matches")', async () => {
    await renderPulls('/pulls?type=review_requested&state=all', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await screen.findByText('Needs a connection')).toBeTruthy();
    expect(screen.queryByText('Nothing matches')).toBeNull();
  });

  test('state All lists the merged pull requests the server names', async () => {
    await renderPulls('/pulls?type=review_requested&state=all', (url) => json(url.searchParams.get('state') === 'all' ? [{id: 111}, {id: 107}] : []));
    expect(await screen.findByText('Merged two')).toBeTruthy();
    expect(screen.getByText('Merged one')).toBeTruthy();
  });
});

test('the filters follow GitHub\'s order and wording, the repositories on this device last', async () => {
  await renderPulls('/pulls?type=review_requested', () => json([]));
  const filter = await screen.findByLabelText('My work filter');
  expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual(['Created', 'Assigned', 'Mentioned', 'Review requests', 'Your repositories']);
  expect(within(filter).getByRole('button', {name: 'Review requests'}).getAttribute('aria-pressed')).toBe('true');
});

describe('emptyText', () => {
  test('online and answered: the empty "Review requested" / "Mentioned" lists do not say they need a connection', () => {
    const review = emptyText('review_requested', true, 'open', 'answered', 'online');
    expect(review.title).toBe('All clear');
    expect(review.description).toBe('Nothing open is waiting for your review. Closed and merged pull requests are not listed here: choose All to see them.');
    expect(review.description).not.toContain('connection');
    const mentionedPulls = emptyText('mentioned', true, 'open', 'answered', 'online');
    expect(mentionedPulls.description).toBe('Nothing open mentions you. Closed and merged pull requests are not listed here: choose All to see them.');
    const mentionedIssues = emptyText('mentioned', false, 'open', 'answered', 'online');
    expect(mentionedIssues.description).toBe('Nothing open mentions you. Closed issues are not listed here: choose All to see them.');
    expect(mentionedIssues.description).not.toContain('connection');
  });

  test('closed and all: the answered text fits the state (no "choose All", no "closed are not listed")', () => {
    expect(emptyText('review_requested', true, 'closed', 'answered', 'online').description).toBe('No closed or merged pull request is waiting for your review.');
    expect(emptyText('review_requested', true, 'all', 'answered', 'online').description).toBe('Nothing is waiting for your review, open, closed or merged.');
    expect(emptyText('mentioned', true, 'closed', 'answered', 'online').description).toBe('No closed or merged pull request mentions you.');
    expect(emptyText('mentioned', true, 'all', 'answered', 'online').description).toBe('No pull request mentions you, open, closed or merged.');
    expect(emptyText('mentioned', false, 'closed', 'answered', 'online').description).toBe('No closed issue mentions you.');
    expect(emptyText('mentioned', false, 'all', 'answered', 'online').description).toBe('No issue mentions you, open or closed.');
    for (const type of ['review_requested', 'mentioned'] as const) {
      for (const state of ['closed', 'all'] as const) {
        const t = emptyText(type, true, state, 'answered', 'online');
        expect(t.description).not.toContain('choose All');
        expect(t.description).not.toContain('not listed');
      }
    }
  });

  test('a connection is mentioned only when Forgejo could not be asked, whatever the state', () => {
    for (const t of ['review_requested', 'mentioned'] as const) {
      for (const state of ['open', 'closed', 'all'] as const) {
        expect(emptyText(t, true, state, 'unanswered', 'online').title).toBe('Needs a connection');
        expect(emptyText(t, true, state, 'asking', 'offline').title).toBe('Needs a connection');
        expect(emptyText(t, true, state, 'asking', 'unreachable').title).toBe('Needs a connection');
        const asking = emptyText(t, true, state, 'asking', 'online');
        expect(asking.title).toBe('Asking Forgejo…');
        expect(asking.description).not.toContain('connection');
      }
    }
    expect(emptyText('review_requested', true, 'open', 'unanswered', 'offline').description).toContain('Review requests are not kept on this device and Forgejo could not be asked');
  });

  test('the synced lists keep their wording whatever the server status', () => {
    expect(emptyText(undefined, false, 'open', 'asking', 'offline')).toEqual({title: 'All clear', description: 'Nothing open in the repositories on this device.'});
    expect(emptyText('assigned', true, 'open', 'asking', 'online')).toEqual({title: 'All clear', description: 'Nothing open is assigned to you.'});
    expect(emptyText('created_by', true, 'open', 'unanswered', 'online')).toEqual({title: 'All clear', description: 'You have not opened anything that is still open.'});
  });
});
