// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Which notifications mention the viewer or wait for their review, as the
// server knows it. Forgejo stores no reason on a notification, and what the
// inbox could derive it from on this device (the notifying comment's body, a
// pull request's review requests) lives in each issue's own group, held only
// once that issue was opened here: a fresh device read every mention as
// "Commented" and Reason: Mentioned listed nothing (#168). API v1's issue
// search names them (`mentioned`, `review_requested`, as My issues and My
// pull requests ask), for issues and pull requests alike. Asked when the
// inbox opens and again when notifications arrive (at most every FRESH ms),
// remembered on this device so the next visit shows them at once.

import {observable, runInAction} from 'mobx';
import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

export interface ServerReasons {
  /** Issues (ids) that mention the viewer. */
  mentioned: ReadonlySet<number>;
  /** Pull requests (issue ids) waiting for the viewer's review (theirs or a team's). */
  reviewRequested: ReadonlySet<number>;
}

interface Known extends ServerReasons {
  userId: number;
}

const known = observable.box<Known | undefined>(undefined, {deep: false});

const KEY = 'forgejo-next:inbox-reasons';
/** Forgejo's default page size limit (API.MAX_RESPONSE_ITEMS). */
const PAGE = 50;
/** At most this many pages per question (the most recently updated issues first). */
const PAGES = 10;
/** How long an answer is fresh: notifications arriving within it do not ask again at once. */
export const FRESH = 30_000;

let inflight = false;
let again = false;
let askedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function load(userId: number): void {
  if (known.get()?.userId === userId) return;
  let value: Known | undefined;
  try {
    const raw = JSON.parse(localStorage.getItem(`${KEY}:${String(userId)}`) ?? 'null') as {mentioned?: unknown; reviewRequested?: unknown} | null;
    const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
    if (raw && typeof raw === 'object') value = {userId, mentioned: ids(raw.mentioned), reviewRequested: ids(raw.reviewRequested)};
  } catch {
    // Storage blocked: asked again online.
  }
  runInAction(() => {
    known.set(value);
  });
}

function save(v: Known): void {
  try {
    localStorage.setItem(`${KEY}:${String(v.userId)}`, JSON.stringify({mentioned: [...v.mentioned], reviewRequested: [...v.reviewRequested]}));
  } catch {
    // Storage blocked or full: kept for this tab only.
  }
}

/** What the server said (observes it); undefined until it answered once (on this device). */
export function serverReasons(app: App): ServerReasons | undefined {
  const s = app.session;
  if (!s) return undefined;
  load(s.userId);
  const v = known.get();
  return v?.userId === s.userId ? v : undefined;
}

async function issueIds(app: App, flag: 'mentioned' | 'review_requested', since: string | undefined): Promise<Set<number>> {
  const ids = new Set<number>();
  const params = new URLSearchParams({[flag]: 'true', state: 'all', sort: 'recentupdate', limit: String(PAGE)});
  if (since) params.set('since', since);
  for (let page = 1; page <= PAGES; page++) {
    params.set('page', String(page));
    const list = await online<{id?: unknown}[]>(app, {api: 'v1', path: `/repos/issues/search?${params.toString()}`});
    if (!Array.isArray(list)) break;
    for (const i of list) if (typeof i.id === 'number') ids.add(i.id);
    if (list.length < PAGE) break;
  }
  return ids;
}

/**
 * Asks the server again (online), unless an answer is fresh (`force`: ask anyway, e.g. when the inbox opens).
 * `since`: the oldest notification's creation time — an issue that mentioned the viewer since was updated since
 * (computed only when it asks).
 */
export function askServerReasons(app: App, since: () => string | undefined, force = false): void {
  const s = app.session;
  if (!s) return;
  load(s.userId);
  if (inflight) {
    again = true;
    return;
  }
  const wait = askedAt + FRESH - Date.now();
  if (!force && wait > 0) {
    timer ??= setTimeout(() => {
      timer = undefined;
      askServerReasons(app, since);
    }, wait);
    return;
  }
  inflight = true;
  again = false;
  askedAt = Date.now();
  void (async () => {
    try {
      const from = since();
      const [mentioned, reviewRequested] = await Promise.all([issueIds(app, 'mentioned', from), issueIds(app, 'review_requested', from)]);
      if (app.session?.userId !== s.userId) return;
      const value: Known = {userId: s.userId, mentioned, reviewRequested};
      runInAction(() => {
        known.set(value);
      });
      save(value);
    } catch {
      // Offline, or Forgejo not answering: the last answer stays; asked again on the next visit.
      askedAt = 0;
    } finally {
      inflight = false;
      if (again) askServerReasons(app, since);
    }
  })();
}

/** For tests: forgets every answer and question. */
export function resetServerReasons(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  inflight = false;
  again = false;
  askedAt = 0;
  runInAction(() => {
    known.set(undefined);
  });
}
