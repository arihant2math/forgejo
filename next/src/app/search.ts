// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Typed search params of the list routes. Names and values follow the
// classic UI's query strings, so a URL means the same in both UIs. Unknown
// or malformed values are dropped (the route then shows its default); F4
// extends these with filters and sorting.

const MY_TYPES = ['your_repositories', 'assigned', 'created_by', 'mentioned', 'review_requested'] as const;
const STATES = ['open', 'closed', 'all'] as const;

export type MyListType = typeof MY_TYPES[number];
export type ListState = typeof STATES[number];

/** /issues, /pulls (the viewer's work across repositories). */
export interface MyListSearch {
  type?: MyListType;
  state?: ListState;
}

/** /{owner}/{repo}/issues, /pulls. */
export interface IssueListSearch {
  state?: ListState;
  q?: string;
}

function oneOf<T extends string>(values: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : undefined;
}

export function myListSearch(s: Record<string, unknown>): MyListSearch {
  const type = oneOf(MY_TYPES, s.type);
  const state = oneOf(STATES, s.state);
  return {...(type ? {type} : {}), ...(state ? {state} : {})};
}

export function issueListSearch(s: Record<string, unknown>): IssueListSearch {
  const state = oneOf(STATES, s.state);
  const q = typeof s.q === 'string' && s.q.trim() ? s.q.slice(0, 256) : undefined;
  return {...(state ? {state} : {}), ...(q ? {q} : {})};
}
