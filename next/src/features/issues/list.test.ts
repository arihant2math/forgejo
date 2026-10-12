// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

import {autorun, runInAction} from 'mobx';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {KeyedFlags} from './flags.ts';
import {IssueListModel} from './list.ts';

function setup() {
  const session = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), session);
  const d = session.data;
  const dev = user(1, 'dev');
  d.put('User', 'profiles:public', dev);
  d.put('Repository', 'repo:10', repo(10, dev, 'big'));
  for (let i = 1; i <= 5; i++) d.put('Issue', 'repo:10', issue(i, 10, i, `Issue ${String(i)}`, {created_at: `2026-01-0${String(i)}T00:00:00Z`}));
  d.put('Issue', 'repo:10', issue(6, 10, 6, 'A pull', {is_pull: true}));
  const {overlay} = editing(app);
  const model = new IssueListModel(app, overlay, {kind: 'repo', repoId: 10, pulls: false});
  model.setSearch({});
  return {app, d, overlay, model};
}

describe('IssueListModel', () => {
  test('rows from the pool; an overlay change shows in the same reaction; the same rows keep their identity', async () => {
    const {d, overlay, model} = setup();
    const results: number[][] = [];
    const off = autorun(() => {
      results.push(model.result.get().ids);
    });
    expect(results).toEqual([[5, 4, 3, 2, 1]]);
    overlay.add('i1', [{t: 'field', model: 'Issue', id: 3, field: 'state', value: 'closed'}]);
    expect(results.at(-1)).toEqual([5, 4, 2, 1]);
    // Cell-only changes preserve row identity after a coalesced recomputation.
    const before = results.length;
    d.put('Issue', 'repo:10', issue(2, 10, 2, 'Renamed', {created_at: '2026-01-02T00:00:00Z'}));
    await new Promise((r) => setTimeout(r, 40));
    expect(results.length).toBe(before);
    d.put('Issue', 'repo:10', issue(9, 10, 9, 'New', {created_at: '2026-02-01T00:00:00Z'}));
    await vi.waitFor(() => {
      expect(results.at(-1)).toEqual([9, 5, 4, 2, 1]);
    });
    model.setSearch({state: 'all', sort: 'oldest'});
    expect(results.at(-1)).toEqual([1, 2, 3, 4, 5, 9]);
    off();
    model.dispose();
  });

  test('many pool batches in one frame recompute once', async () => {
    const {d, model} = setup();
    let computations = 0;
    const off = autorun(() => {
      model.result.get();
      computations++;
    });
    for (let i = 20; i < 60; i++) d.put('Issue', 'repo:10', issue(i, 10, i, `Bulk ${String(i)}`));
    await vi.waitFor(() => {
      expect(model.result.get().ids).toHaveLength(45);
    });
    expect(computations).toBe(2);
    off();
    model.dispose();
  });
});

describe('IssueListModel, a list the server names', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reviewList(answer: () => Promise<Response>) {
    const session = fakeSession({userId: 1});
    vi.spyOn(session.auth, 'token').mockResolvedValue('t');
    const fetchMock = vi.fn((_url: string) => answer());
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(fallbackConfig(), session);
    const model = new IssueListModel(app, editing(app).overlay, {kind: 'my', pulls: true, type: 'review_requested'});
    model.setSearch({});
    return {model, fetchMock, app};
  }

  test('an empty answer is answered (not a missing connection); open items only are asked for', async () => {
    const {model, fetchMock} = reviewList(() => Promise.resolve(new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}})));
    expect(model.serverStatus).toBe('asking');
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    expect(model.result.get().ids).toEqual([]);
    const url = new URL(fetchMock.mock.calls[0]?.[0] ?? '', 'http://x');
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('review_requested')).toBe('true');
    model.dispose();
  });

  test('no answer (offline, an error status) is unanswered; asking again starts over', async () => {
    let fail = true;
    const {model} = reviewList(() => (fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response('[]', {status: 200}))));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('unanswered');
    });
    fail = false;
    window.dispatchEvent(new Event('online'));
    expect(model.serverStatus).toBe('asking');
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    model.dispose();
  });

  test('another state: an answer for the previous state is not this one\'s (asking until its own arrives)', async () => {
    const answers: ((r: Response) => void)[] = [];
    const {model} = reviewList(() => new Promise<Response>((resolve) => {
      answers.push(resolve);
    }));
    await vi.waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    answers[0]?.(new Response('[]', {status: 200}));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    model.setSearch({state: 'all'});
    expect(model.serverStatus).toBe('asking');
    await vi.waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    answers[1]?.(new Response('[]', {status: 200}));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    model.dispose();
  });

  test('lists of one session share the answer: a second list (Home, then My pull requests) asks nothing', async () => {
    const {model, fetchMock, app} = reviewList(() => Promise.resolve(new Response('[]', {status: 200})));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    model.dispose();
    const again = new IssueListModel(app, editing(app).overlay, {kind: 'my', pulls: true, type: 'review_requested'});
    again.setSearch({});
    expect(again.serverStatus).toBe('answered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    again.dispose();
  });

  test('a full first page with a total count asks for the other pages at once', async () => {
    const page = (n: number) => Array.from({length: 50}, (_, i) => ({id: n * 100 + i}));
    const {model, fetchMock} = reviewList(() => Promise.resolve(new Response('', {status: 200})));
    let inFlight = 0;
    let most = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const n = Number(new URL(url, 'http://x').searchParams.get('page'));
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify(n < 3 ? page(n) : page(n).slice(0, 7)), {status: 200, headers: {'X-Total-Count': '107'}});
    });
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('answered');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(most).toBe(2);
    expect(model.result.get().ids).toEqual([]); // ids outside the pool are not rows
    model.dispose();
  });

  test('a list closed while offline does not ask again when the browser comes back online', async () => {
    const {model, fetchMock} = reviewList(() => Promise.reject(new TypeError('Failed to fetch')));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('unanswered');
    });
    model.dispose();
    window.dispatchEvent(new Event('online'));
    // send() awaits the auth token before fetching, so let that settle first.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a server error is unanswered too', async () => {
    const {model} = reviewList(() => Promise.resolve(new Response('', {status: 500})));
    await vi.waitFor(() => {
      expect(model.serverStatus).toBe('unanswered');
    });
    model.dispose();
  });
});

describe('KeyedFlags', () => {
  test('has(id) reacts to that id only', () => {
    const f = new KeyedFlags();
    const runs = {a: 0, b: 0};
    const offs = [autorun(() => {
      f.has(1);
      runs.a++;
    }), autorun(() => {
      f.has(2);
      runs.b++;
    })];
    runInAction(() => {
      f.replace([1]);
    });
    f.replace([1]);
    expect(runs).toEqual({a: 2, b: 1});
    f.toggle(2);
    expect(runs).toEqual({a: 2, b: 2});
    f.clear();
    expect(runs).toEqual({a: 3, b: 3});
    for (const o of offs) o();
  });
});
