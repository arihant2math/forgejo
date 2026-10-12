// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {reviewerStates, reviewVerdicts} from './verdicts.ts';

const review = (reviewer_id: number, state: string, created_at: string, dismissed = false) => ({reviewer_id, state, created_at, dismissed});

test('review verdicts ignore replies and use each reviewer’s latest non-dismissed decision', () => {
  const verdicts = reviewVerdicts([
    review(1, 'REQUEST_CHANGES', '1'),
    review(1, 'COMMENT', '2'),
    review(2, 'COMMENT', '3'),
    review(3, 'APPROVED', '1'),
    review(3, 'REQUEST_CHANGES', '2'),
    review(3, 'APPROVED', '3', true),
    review(1, 'PENDING', '4'),
  ]);
  expect([...verdicts]).toEqual([[1, {state: 'REQUEST_CHANGES', at: '1'}], [3, {state: 'REQUEST_CHANGES', at: '2'}]]);
  expect(reviewVerdicts([review(1, 'APPROVED', '2'), review(1, 'REQUEST_CHANGES', '1')]).get(1)?.state).toBe('APPROVED');
});

test('reviewer states keep the verdict, and name reviewers who only commented', () => {
  const states = reviewerStates([review(1, 'REQUEST_CHANGES', '1'), review(1, 'COMMENT', '2'), review(2, 'COMMENT', '3'), review(3, 'PENDING', '1'), review(4, 'COMMENT', '1', true)]);
  expect([...states]).toEqual([[1, 'REQUEST_CHANGES'], [2, 'COMMENT']]);
});
