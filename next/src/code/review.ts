// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reviewing a pull request offline (PLAN §5.4, §5.5).
//
// Comments are drafted on diff lines and kept as durable drafts (the F5
// `drafts` store, with their anchor: path, side, line, commit) — they
// survive reloads and crashes, show in every tab and in "Unsynced changes",
// and cost no request. Submitting is one offline intent, `review.submit`,
// pinned to the head commit the user saw, that carries the comments: one
// API v1 call (POST …/pulls/{n}/reviews, with one Idempotency-Key: a retry
// replays it, never posts twice). API v1 cannot create a server-side pending
// review without a body, so drafts are not sent one by one; a pending review
// started in the classic UI is submitted with this one, as Forgejo does.
// Limit: Forgejo itself adds the comments one by one before submitting, so a
// refusal half-way (422) leaves the earlier ones as a pending review there;
// the failed intent keeps every text in "Unsynced changes".
//
// A draft written on another commit than the one submitted cannot be placed
// by line number: it is not lost — it goes into the review's body, quoted
// with its file and line, and the submit dialog says so first.

import {uuid} from '../intents/intents.ts';
import type {Intents} from '../intents/executor.ts';
import type {DraftRecord} from '../intents/store.ts';
import {type Anchor, signedLine} from './anchor.ts';

export type ReviewEvent = 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewDraft {
  key: string;
  anchor: Anchor;
  text: string;
  at: number;
}

const prefix = (issueId: number) => `review:${String(issueId)}:`;

/** The review comment drafts of a pull request (observes the drafts map), by file and line (stable when one is edited). */
export function reviewDrafts(intents: Pick<Intents, 'drafts'>, issueId: number): ReviewDraft[] {
  const p = prefix(issueId);
  const out: ReviewDraft[] = [];
  for (const d of intents.drafts.values()) {
    if (d.kind === 'text' && d.key.startsWith(p) && d.anchor) out.push({key: d.key, anchor: d.anchor, text: d.text ?? '', at: d.at});
  }
  return out.sort((a, b) => (a.anchor.path < b.anchor.path ? -1 : a.anchor.path > b.anchor.path ? 1 : 0) ||
    a.anchor.line - b.anchor.line || a.anchor.side.localeCompare(b.anchor.side) || a.key.localeCompare(b.key));
}

/** Saves (creates or updates) a draft comment; returns its key. */
export function saveDraft(intents: Pick<Intents, 'keepText'>, at: {issueId: number; repoId: number; number: number; anchor: Anchor; text: string; key?: string | undefined}): string {
  const key = at.key ?? `${prefix(at.issueId)}${uuid()}`;
  const d: Omit<DraftRecord, 'kind' | 'at'> = {
    key, issueId: at.issueId, repoId: at.repoId, text: at.text, anchor: at.anchor,
    title: `Review comment on ${at.anchor.path}:${String(at.anchor.line)} (#${String(at.number)})`,
  };
  void intents.keepText(d);
  return key;
}

/** Splits drafts into those placed on `head` and those written on another commit. */
export function partition(drafts: readonly ReviewDraft[], head: string): {current: ReviewDraft[]; stale: ReviewDraft[]} {
  const current: ReviewDraft[] = [];
  const stale: ReviewDraft[] = [];
  for (const d of drafts) (d.anchor.commit === head ? current : stale).push(d);
  return {current, stale};
}

/** The review body with the drafts that cannot be placed quoted under it. */
export function bodyWith(body: string, stale: readonly ReviewDraft[]): string {
  if (!stale.length) return body;
  const quoted = stale.map((d) => `**${d.anchor.path}:${String(d.anchor.line)}** (${d.anchor.side === 'old' ? 'old' : 'new'} file, commit ${d.anchor.commit.slice(0, 10)})\n\n${d.text.split('\n').map((l) => `> ${l}`).join('\n')}`);
  return [body, ...quoted].filter(Boolean).join('\n\n');
}

/**
 * Submits the review as an offline intent pinned to `head`, then drops the
 * drafts it carries (a failure keeps the whole text in the failed intent's draft).
 */
export function submitReview(intents: Pick<Intents, 'submit' | 'discardDraft'>, at: {issueId: number; repoId: number; head: string; event: ReviewEvent; body: string; drafts: readonly ReviewDraft[]}): string {
  const {current, stale} = partition(at.drafts, at.head);
  const sent = intents.submit({
    kind: 'review.submit', issueId: at.issueId, repoId: at.repoId, tempId: uuid(), commitId: at.head, event: at.event,
    body: bodyWith(at.body, stale),
    comments: current.map((d) => {
      const line = signedLine(d.anchor);
      return {path: d.anchor.path, body: d.text, newLine: line > 0 ? line : 0, oldLine: line < 0 ? -line : 0};
    }),
  });
  for (const d of at.drafts) void intents.discardDraft(d.key);
  return sent.id;
}
