// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server's issue search (PLAN §5.1: Forgejo's issue indexer covers what
// is not on this device — closed issues beyond the summary tier, other
// repositories, body text). Online only; the palette asks it when typing
// pauses and shows what the local search did not find.

import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

export interface ServerHit {
  id: number;
  number: number;
  title: string;
  state: string;
  pull: boolean;
  owner: string;
  repo: string;
  fullName: string;
}

interface ApiIssue {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  state?: unknown;
  pull_request?: unknown;
  repository?: {owner?: unknown; name?: unknown; full_name?: unknown};
}

/** Parses API v1's issue list defensively (only well-formed entries come through). */
export function parseServerHits(list: unknown): ServerHit[] {
  if (!Array.isArray(list)) return [];
  const out: ServerHit[] = [];
  for (const raw of list as ApiIssue[]) {
    const r = raw.repository;
    if (typeof raw.id !== 'number' || typeof raw.number !== 'number' || typeof raw.title !== 'string' || !r ||
      typeof r.owner !== 'string' || typeof r.name !== 'string' || typeof r.full_name !== 'string') continue;
    out.push({
      id: raw.id, number: raw.number, title: raw.title, state: raw.state === 'closed' ? 'closed' : 'open',
      pull: raw.pull_request !== null && raw.pull_request !== undefined, owner: r.owner, repo: r.name, fullName: r.full_name,
    });
  }
  return out;
}

/** Searches every issue and pull request the viewer can read (title and body), open and closed. */
export async function searchServer(app: App, query: string, signal: AbortSignal, limit = 10): Promise<ServerHit[]> {
  const params = new URLSearchParams({q: query, state: 'all', limit: String(limit)});
  const t0 = performance.now();
  const list = await online(app, {api: 'v1', path: `/repos/issues/search?${params.toString()}`, signal, timeout: 10_000});
  try {
    performance.measure('search:server', {start: t0, end: performance.now()});
  } catch {
    // No User Timing.
  }
  return parseServerHits(list);
}
