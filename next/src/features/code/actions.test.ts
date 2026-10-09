// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it, test} from 'vitest';
import {duration, eventText, took, triggerOf} from './Actions.tsx';
import {treeOrder} from './tree.tsx';

test('a duration is never negative', () => {
  expect(duration(-35)).toBe('0 s');
  expect(duration(125)).toBe('2 m 5 s');
  expect(duration(3780)).toBe('1 h 3 m');
});

test('took: from the start to the stop (or now), nothing for unknown or contradicting times', () => {
  expect(took('2026-10-01T10:00:00Z', '2026-10-01T10:00:45Z')).toBe('45 s');
  expect(took('2026-10-01T10:00:00Z', undefined, Date.parse('2026-10-01T10:02:05Z'))).toBe('2 m 5 s');
  expect(took(undefined, '2026-10-01T10:00:45Z')).toBeUndefined();
  expect(took('0001-01-01T00:00:00Z', '2026-10-01T10:00:45Z')).toBeUndefined();
  // A runner's clock behind the server's: "Successful in -35s" upstream; here no time at all.
  expect(took('2026-10-01T10:00:35Z', '2026-10-01T10:00:00Z')).toBeUndefined();
});

describe('triggerOf', () => {
  it('names what started a run', () => {
    expect(triggerOf('refs/pull/91/head')).toEqual({kind: 'pull', number: 91});
    expect(triggerOf('refs/heads/feature/x')).toEqual({kind: 'branch', name: 'feature/x'});
    expect(triggerOf('refs/tags/v1.0')).toEqual({kind: 'tag', name: 'v1.0'});
    expect(triggerOf('main')).toEqual({kind: 'other', name: 'main'});
    expect(eventText('pull_request_sync')).toBe('pull request sync');
  });
});

describe('treeOrder', () => {
  it('lists directories first, then in git order', () => {
    const e = (name: string, type = 'blob') => ({name, type, sha: name, mode: '', size: 1});
    expect(treeOrder([e('projection_test.go'), e('projection.go'), e('B.go'), e('a.go'), e('zdir', 'tree'), e('adir', 'tree')]).map((x) => x.name))
      .toEqual(['adir', 'zdir', 'B.go', 'a.go', 'projection.go', 'projection_test.go']);
  });
});
