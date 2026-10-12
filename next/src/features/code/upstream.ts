// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useState} from 'react';
import {online} from '../../app/api.ts';
import {useApp} from '../../app/store.ts';
import {usePool} from '../issues/cells.tsx';
import {codeTo} from './nav.tsx';
import {compareSplat, forkHead} from './proposal.ts';

export interface Upstream {
  owner: string;
  name: string;
  defaultBranch: string;
}

interface ApiRepo {
  parent?: {owner?: {login?: string}; name?: string; default_branch?: string} | null;
}

const upstreams = new Map<string, Promise<Upstream | undefined>>();

/** Prefer the pool, else API v1 parent; undefined means not a fork or not yet known. */
export function useUpstream(owner: string, repo: string, repoId: number): Upstream | undefined {
  const app = useApp();
  const pool = usePool();
  const r = pool.model('Repository').get(repoId)?.data;
  const fork = r?.fork === true;
  const parent = fork && r.parent_id > 0 ? pool.model('Repository').get(r.parent_id)?.data : undefined;
  const pooled: Upstream | undefined = parent ? {owner: parent.owner_name, name: parent.name, defaultBranch: parent.default_branch} : undefined;
  const key = `${owner}/${repo}`;
  const [fetched, setFetched] = useState<{key: string; up: Upstream | undefined}>();
  const known = pooled !== undefined;
  useEffect(() => {
    if (!fork || known) return undefined;
    let live = true;
    let asked = upstreams.get(key);
    if (!asked) {
      asked = online<ApiRepo>(app, {api: 'v1', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}).then((j) => {
        const p = j?.parent;
        return p?.owner?.login && p.name ? {owner: p.owner.login, name: p.name, defaultBranch: p.default_branch ?? ''} : undefined;
      });
      asked.catch(() => upstreams.delete(key));
      upstreams.set(key, asked);
    }
    asked.then((up) => {
      if (live) setFetched({key, up});
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [app, fork, known, key, owner, repo]);
  return pooled ?? (fork && fetched?.key === key ? fetched.up : undefined);
}

export function proposalTarget(owner: string, repo: string, base: string, head: string, up: Upstream | undefined): {to: ReturnType<typeof codeTo>; into: string} {
  if (up?.defaultBranch) {
    return {to: codeTo(up.owner, up.name, compareSplat(up.defaultBranch, forkHead(owner, repo, up.owner, head))), into: `${up.owner}/${up.name}:${up.defaultBranch}`};
  }
  return {to: codeTo(owner, repo, compareSplat(base, head)), into: base};
}
