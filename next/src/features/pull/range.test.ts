// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {commitsSince, lastReviewCommit, rangeCommits} from './range.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const review = (id: number, reviewer_id: number, state: string, commit_id: string, created_at: string) => ({id, reviewer_id, state, commit_id, created_at});

test('the viewer\'s last submitted review, when the head moved since', () => {
  const reviews = [
    review(1, 1, 'APPROVED', A, '2026-01-01T00:00:00Z'),
    review(2, 1, 'COMMENT', B, '2026-01-02T00:00:00Z'),
    review(3, 1, 'PENDING', C, '2026-01-03T00:00:00Z'), // not submitted
    review(4, 2, 'REQUEST_CHANGES', C, '2026-01-04T00:00:00Z'), // someone else's
    review(5, 1, 'REQUEST_REVIEW', C, '2026-01-05T00:00:00Z'), // a request, not a review
  ];
  expect(lastReviewCommit(reviews, 1, D)).toBe(B);
  expect(lastReviewCommit(reviews, 1, B)).toBeUndefined(); // reviewed at the head: nothing new
  expect(lastReviewCommit(reviews, 3, D)).toBeUndefined();
  expect(lastReviewCommit([review(6, 1, 'COMMENT', '', '2026-01-06T00:00:00Z')], 1, D)).toBeUndefined();
});

test('a range\'s two commits', () => {
  const commits = {base: A, head: D};
  expect(rangeCommits({kind: 'all'}, commits)).toEqual({base: A, to: D});
  expect(rangeCommits({kind: 'review', base: B}, commits)).toEqual({base: B, to: D});
  expect(rangeCommits({kind: 'commit', sha: C}, commits)).toEqual({base: '', to: C});
});

test('commits since a review: walked from the head, unknown when the review\'s commit is not an ancestor', () => {
  const commits = [{sha: D, parents: [C]}, {sha: C, parents: [B]}, {sha: B, parents: [A]}];
  expect(commitsSince(commits, D, B)).toBe(2);
  expect(commitsSince(commits, D, C)).toBe(1);
  expect(commitsSince(commits, D, 'e'.repeat(40))).toBeUndefined(); // force-pushed away
  // A merge commit: both sides count once.
  expect(commitsSince([{sha: D, parents: [C, B]}, {sha: C, parents: [A]}, {sha: B, parents: [A]}], D, A)).toBe(3);
});
