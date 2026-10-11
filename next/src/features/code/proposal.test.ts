// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import type {Label} from '../../protocol/types.gen.ts';
import {compareSplat, createPullBody, headChoices, isForkHead, mergeOutlook, type OutlookInput, proposable, pullDefaults, TITLE_MAX, withLabel} from './proposal.ts';

describe('the proposed title and description', () => {
  test('one commit: its summary and the rest of its message', () => {
    expect(pullDefaults([{message: 'Fix the parser\n\nIt dropped the last line.\nCloses #4\n'}], 1, 'fix/parser'))
      .toEqual({title: 'Fix the parser', body: 'It dropped the last line.\nCloses #4'});
    expect(pullDefaults([{message: '  Only a summary  '}], 1, 'x')).toEqual({title: 'Only a summary', body: ''});
  });

  test('several commits (or a list cut short): the head branch', () => {
    expect(pullDefaults([{message: 'a'}, {message: 'b'}], 2, 'feature/login')).toEqual({title: 'feature/login', body: ''});
    // The list has one commit but the comparison counts more: still the branch.
    expect(pullDefaults([{message: 'a'}], 3, 'feature/login')).toEqual({title: 'feature/login', body: ''});
  });

  test('an empty summary falls back to the branch', () => {
    expect(pullDefaults([{message: '\n\n'}], 1, 'topic').title).toBe('topic');
  });

  test('a title over the limit is cut; the rest opens the description', () => {
    const long = `${'é'.repeat(TITLE_MAX)}xyz`;
    const d = pullDefaults([{message: `${long}\n\nBody.`}], 1, 'b');
    expect(Array.from(d.title)).toHaveLength(TITLE_MAX);
    expect(d.title.endsWith('…')).toBe(true);
    expect(d.body).toBe('…éxyz\n\nBody.');
    expect(pullDefaults([{message: long}], 1, 'b').body).toBe('…éxyz');
  });
});

describe('the merge outlook', () => {
  const base: OutlookInput = {baseSha: 'a', headSha: 'b', ahead: 2, behind: 0, headFiles: ['x.go'], baseFiles: []};

  test('nothing to propose', () => {
    expect(mergeOutlook({...base, headSha: 'a'})).toEqual({kind: 'identical'});
    expect(mergeOutlook({...base, ahead: 0})).toEqual({kind: 'up-to-date'});
    expect(proposable({kind: 'identical'})).toBe(false);
    expect(proposable({kind: 'up-to-date'})).toBe(false);
  });

  test('loading, step by step', () => {
    expect(mergeOutlook({...base, ahead: undefined})).toEqual({kind: 'checking'});
    expect(mergeOutlook({...base, headFiles: undefined})).toEqual({kind: 'checking'});
    expect(mergeOutlook({...base, behind: undefined})).toEqual({kind: 'checking'});
    expect(mergeOutlook({...base, behind: 3, baseFiles: undefined})).toEqual({kind: 'checking'});
  });

  test('commits that change nothing', () => {
    expect(mergeOutlook({...base, headFiles: []})).toEqual({kind: 'empty'});
    expect(proposable({kind: 'empty'})).toBe(true);
  });

  test('a fast-forward, other files, the same files, unreadable', () => {
    expect(mergeOutlook(base)).toEqual({kind: 'clean', behind: 0});
    expect(mergeOutlook({...base, behind: 4, baseFiles: ['y.go']})).toEqual({kind: 'clean', behind: 4});
    expect(mergeOutlook({...base, behind: 4, headFiles: ['z.go', 'x.go', 'x.go'], baseFiles: ['x.go', 'z.go', 'q']})).toEqual({kind: 'overlap', behind: 4, files: ['x.go', 'z.go']});
    expect(mergeOutlook({...base, behind: 1, baseFiles: null})).toEqual({kind: 'unknown', behind: 1});
  });
});

test('head choices: newest push first, the viewer before others at the same time, never the base', () => {
  const b = (name: string, commitTime: string, pusherId = 2) => ({name, commitTime, pusherId});
  const out = headChoices([b('main', '2026-10-09'), b('old', '2026-01-01'), b('theirs', '2026-10-10'), b('mine', '2026-10-10', 1), b('new', '2026-10-11')], 'main', 1);
  expect(out.map((x) => x.name)).toEqual(['new', 'mine', 'theirs', 'old']);
});

test('labels: an exclusive scoped label replaces its siblings', () => {
  const l = (id: number, name: string, exclusive = false) => ({id, name, exclusive}) as Label;
  const bug = l(1, 'bug');
  const low = l(3, 'priority/low', true);
  const ui = l(4, 'area/ui');
  const all = [bug, l(2, 'priority/high', true), low, ui];
  expect(withLabel([1, 2], low, true, all)).toEqual([1, 3]);
  expect(withLabel([1, 2], ui, true, all)).toEqual([1, 2, 4]);
  expect(withLabel([1, 2], bug, false, all)).toEqual([2]);
  expect(withLabel([1], bug, true, all)).toEqual([1]);
});

test('the request API v1 takes', () => {
  expect(createPullBody({base: 'main', head: 'f', title: '  T ', body: 'B', labelIds: [], assignees: [], milestoneId: 0}))
    .toEqual({base: 'main', head: 'f', title: 'T', body: 'B'});
  expect(createPullBody({base: 'main', head: 'f', title: 'T', body: '', labelIds: [3], assignees: ['alice'], milestoneId: 7}))
    .toEqual({base: 'main', head: 'f', title: 'T', body: '', labels: [3], assignees: ['alice'], milestone: 7});
});

test('compare paths and fork heads', () => {
  expect(compareSplat('main', 'feature/x')).toBe('compare/main...feature/x');
  expect(isForkHead('alice:feature')).toBe(true);
  expect(isForkHead('alice/atlas:feature')).toBe(true);
  expect(isForkHead('feature/x')).toBe(false);
});
