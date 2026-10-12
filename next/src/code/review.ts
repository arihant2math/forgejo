// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Submit drafts in one idempotent intent: API v1 cannot create an empty pending review.
// Submission includes any classic-UI pending review. A partial refusal can leave pending comments;
// the failed intent retains all text.
// Drafts on a different commit are quoted in the body, not placed by stale line numbers.

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

/** Observes drafts and sorts by file/line, with stable ordering across edits. */
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

export function partition(drafts: readonly ReviewDraft[], head: string): {current: ReviewDraft[]; stale: ReviewDraft[]} {
  const current: ReviewDraft[] = [];
  const stale: ReviewDraft[] = [];
  for (const d of drafts) (d.anchor.commit === head ? current : stale).push(d);
  return {current, stale};
}

export function bodyWith(body: string, stale: readonly ReviewDraft[]): string {
  if (!stale.length) return body;
  const quoted = stale.map((d) => `**${d.anchor.path}:${String(d.anchor.line)}** (${d.anchor.side === 'old' ? 'old' : 'new'} file, commit ${d.anchor.commit.slice(0, 10)})\n\n${d.text.split('\n').map((l) => `> ${l}`).join('\n')}`);
  return [body, ...quoted].filter(Boolean).join('\n\n');
}

/** Discards drafts after enqueueing; failures retain their text in the failed intent. */
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
