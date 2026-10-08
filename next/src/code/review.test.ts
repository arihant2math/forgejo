// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Offline review (PLAN §5.4, §5.5): comments drafted on diff lines are durable
// drafts; submitting is one offline intent pinned to the commit the user saw,
// sent once after reconnecting (caught_up), never twice — not even when the
// answer is lost — and drafts written on another commit are kept in the body.

import 'fake-indexeddb/auto';
import {describe, expect, test, vi} from 'vitest';
import {FakeForgejo} from '../test/fakeForgejo.ts';
import {World} from '../test/fakeTabs.ts';
import {IntentDb} from '../intents/store.ts';
import {bodyWith, partition, reviewDrafts, saveDraft, submitReview} from './review.ts';

const HEAD = 'c'.repeat(40);
const OLD = 'a'.repeat(40);
const pr = {issueId: 1, repoId: 10, number: 1};

describe('review drafts and submit', () => {
  test('drafted offline, submitted offline, sent once on reconnect, pinned to the commit seen', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 2);
    const [tab, other] = world.tabs;
    if (!tab || !other) throw new Error('no tabs');
    tab.setConnection('offline');
    other.setConnection('offline');
    saveDraft(tab.intents, {...pr, anchor: {path: 'a.go', side: 'new', line: 12, commit: HEAD}, text: 'nit: name'});
    const key = saveDraft(tab.intents, {...pr, anchor: {path: 'b.go', side: 'old', line: 3, commit: HEAD}, text: 'why removed?'});
    saveDraft(tab.intents, {...pr, anchor: {path: 'a.go', side: 'new', line: 4, commit: OLD}, text: 'older'});
    // Edit one in place (same key).
    saveDraft(tab.intents, {...pr, key, anchor: {path: 'b.go', side: 'old', line: 3, commit: HEAD}, text: 'why was this removed?'});
    // Durable and shared: another tab and a reload see them.
    await vi.waitFor(() => {
      expect(reviewDrafts(other.intents, 1).map((d) => d.text)).toEqual(['nit: name', 'why was this removed?', 'older']);
    });
    expect((await new IntentDb(world.db).drafts()).filter((d) => d.anchor)).toHaveLength(3);

    submitReview(tab.intents, {...pr, head: HEAD, event: 'REQUEST_CHANGES', body: 'Please fix', drafts: reviewDrafts(tab.intents, 1)});
    await world.settle(20);
    expect(server.reviews).toHaveLength(0);
    expect(tab.intents.pending).toBe(1);
    expect(reviewDrafts(tab.intents, 1)).toEqual([]);

    // Back: the first answer is lost on the way; the retry replays (B7), the server has one review.
    server.online = true;
    server.lose = 1;
    tab.setConnection('live');
    other.setConnection('live');
    await world.settle();
    expect(server.reviews).toHaveLength(1);
    const r = server.reviews[0];
    expect(r?.commit_id).toBe(HEAD);
    expect(r?.event).toBe('REQUEST_CHANGES');
    expect(r?.comments).toEqual([
      {path: 'a.go', body: 'nit: name', new_position: 12, old_position: 0},
      {path: 'b.go', body: 'why was this removed?', new_position: 0, old_position: 3},
    ]);
    expect(r?.body).toContain('Please fix');
    expect(r?.body).toContain('**a.go:4**');
    expect(r?.body).toContain('> older');
    expect([...server.runs.values()].every((n) => n === 1)).toBe(true);
    expect(tab.intents.pending).toBe(0);
    world.close();
  });

  test('partition and body quoting', () => {
    const d = (commit: string, text: string) => ({key: text, anchor: {path: 'x', side: 'new' as const, line: 1, commit}, text, at: 0});
    const {current, stale} = partition([d(HEAD, 'a'), d(OLD, 'b\nc')], HEAD);
    expect(current.map((x) => x.text)).toEqual(['a']);
    expect(bodyWith('', stale)).toBe(`**x:1** (new file, commit ${OLD.slice(0, 10)})\n\n> b\n> c`);
    expect(bodyWith('top', [])).toBe('top');
  });
});
