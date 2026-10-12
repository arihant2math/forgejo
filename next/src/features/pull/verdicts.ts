// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Kept free of imports: issue list rows on the boot route use it.

interface ReviewLike {reviewer_id: number; state: string; created_at: string; dismissed: boolean}

/** Replies, comments and pending reviews do not replace a reviewer's verdict, as on GitHub. */
export function reviewVerdicts(reviews: Iterable<ReviewLike>) {
  const latest = new Map<number, {state: string; at: string}>();
  for (const d of reviews) {
    if (!d.reviewer_id || d.dismissed || (d.state !== 'APPROVED' && d.state !== 'REQUEST_CHANGES')) continue;
    const previous = latest.get(d.reviewer_id);
    if (!previous || previous.at < d.created_at) latest.set(d.reviewer_id, {state: d.state, at: d.created_at});
  }
  return latest;
}

/** Each reviewer's state in a reviewer list: the verdict, or COMMENT for reviewers who only commented. */
export function reviewerStates(reviews: readonly ReviewLike[]): Map<number, string> {
  const out = new Map([...reviewVerdicts(reviews)].map(([id, v]) => [id, v.state]));
  for (const r of reviews) if (r.reviewer_id && !r.dismissed && r.state === 'COMMENT' && !out.has(r.reviewer_id)) out.set(r.reviewer_id, 'COMMENT');
  return out;
}
