// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen} from '@testing-library/react';
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

/** Sam, whose only review requests are on merged pull requests; Forgejo answers the review-requested search with `answer`. */
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

describe('My pull requests > Review requested (QA #261)', () => {
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

  test('state All lists the merged pull requests the server names', async () => {
    await renderPulls('/pulls?type=review_requested&state=all', (url) => json(url.searchParams.get('state') === 'all' ? [{id: 111}, {id: 107}] : []));
    expect(await screen.findByText('Merged two')).toBeTruthy();
    expect(screen.getByText('Merged one')).toBeTruthy();
  });
});


describe('emptyText (QA #261)', () => {
  test('online and answered: the empty "Review requested" / "Mentioned" lists do not say they need a connection', () => {
    const review = emptyText('review_requested', true, 'answered', 'online');
    expect(review.title).toBe('All clear');
    expect(review.description).toBe('Nothing open is waiting for your review. Closed and merged pull requests are not listed here: choose All to see them.');
    expect(review.description).not.toContain('connection');
    const mentionedPulls = emptyText('mentioned', true, 'answered', 'online');
    expect(mentionedPulls.description).toBe('Nothing open mentions you. Closed and merged pull requests are not listed here: choose All to see them.');
    const mentionedIssues = emptyText('mentioned', false, 'answered', 'online');
    expect(mentionedIssues.description).toBe('Nothing open mentions you. Closed issues are not listed here: choose All to see them.');
    expect(mentionedIssues.description).not.toContain('connection');
  });

  test('a connection is mentioned only when Forgejo could not be asked', () => {
    for (const t of ['review_requested', 'mentioned'] as const) {
      expect(emptyText(t, true, 'unanswered', 'online').title).toBe('Needs a connection');
      expect(emptyText(t, true, 'asking', 'offline').title).toBe('Needs a connection');
      expect(emptyText(t, true, 'asking', 'unreachable').title).toBe('Needs a connection');
      // Still asking, online: neither empty nor failed yet.
      const asking = emptyText(t, true, 'asking', 'online');
      expect(asking.title).toBe('Asking Forgejo…');
      expect(asking.description).not.toContain('connection');
    }
    expect(emptyText('review_requested', true, 'unanswered', 'offline').description).toContain('Review requests are not kept on this device and Forgejo could not be asked');
  });

  test('the synced lists keep their wording whatever the server status', () => {
    expect(emptyText(undefined, false, 'asking', 'offline')).toEqual({title: 'All clear', description: 'Nothing open in the repositories on this device.'});
    expect(emptyText('assigned', true, 'asking', 'online')).toEqual({title: 'All clear', description: 'Nothing open is assigned to you.'});
    expect(emptyText('created_by', true, 'unanswered', 'online')).toEqual({title: 'All clear', description: 'You have not opened anything that is still open.'});
  });
});
