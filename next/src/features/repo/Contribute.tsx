// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A fork's standing against its upstream, above its files (classic Forgejo's
// fork_sync_message, GitHub's "This branch is N commits ahead of, M behind"):
// how far its default branch is ahead of the upstream's (with the way to
// propose those commits there) and behind it (with Sync fork, API v1's
// sync_fork: a fast-forward, for writers, when the fork has no commits of its
// own). Forks' upstreams need not be synced to the device: API v1, online.

import {Link} from '@tanstack/react-router';
import {GitPullRequestArrow, RefreshCw} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online, onlineWrite} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Button, Callout, Icon} from '../../ui/index.ts';
import {codeTo} from '../code/nav.tsx';
import {compareSplat, forkHead} from '../code/proposal.ts';

/** API v1's GET /repos/{owner}/{repo}/sync_fork (the fork's default branch and the upstream's branch of that name). */
interface SyncInfo {
  allowed?: boolean;
  commits_behind?: number;
}

interface Standing {
  upstream: {owner: string; name: string; defaultBranch: string};
  /** The fork's default branch. */
  branch: string;
  /** Its commits the upstream's default branch lacks. */
  ahead: number;
  /** The upstream's commits it lacks (the upstream's branch of the same name), and whether Sync can fast-forward it. */
  behind: number;
  syncable: boolean;
}

/** "This branch is 2 commits ahead of, 3 commits behind acme/atlas:main." */
export function standingText(s: Pick<Standing, 'ahead' | 'behind' | 'branch' | 'upstream'>): string {
  const n = (k: number) => `${String(k)} ${k === 1 ? 'commit' : 'commits'}`;
  const up = `${s.upstream.owner}/${s.upstream.name}`;
  if (s.ahead && s.behind) return `This branch is ${n(s.ahead)} ahead of ${up}:${s.upstream.defaultBranch} and ${n(s.behind)} behind ${up}:${s.branch}.`;
  if (s.ahead) return `This branch is ${n(s.ahead)} ahead of ${up}:${s.upstream.defaultBranch}.`;
  return `This branch is ${n(s.behind)} behind ${up}:${s.branch}.`;
}

export const Contribute = observer(function Contribute({owner, repo}: {owner: string; repo: string}) {
  const app = useApp();
  const session = useSession();
  const repoId = [...session.data.pool.model('Repository').all()].find((r) => r.data.owner_name === owner && r.data.name === repo)?.data.id ?? 0;
  const writer = repoId > 0 && canWrite(session, repoId);
  const isOnline = reach(session.data.status.connection) === 'online';
  const [standing, setStanding] = useState<{key: string; value: Standing}>();
  // Asked again after a sync (and when the fork's default branch moves).
  const [round, setRound] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const key = `${owner}/${repo}:${String(round)}`;
  const forkPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      const fork = await online<{default_branch: string; parent?: {owner: {login: string}; name: string; default_branch: string}}>(app, {api: 'v1', path: forkPath, signal: ctl.signal});
      if (!fork?.parent) return;
      const p = fork.parent;
      const head = forkHead(owner, repo, p.owner.login, fork.default_branch);
      const [info, sync] = await Promise.all([
        online<{total_commits: number}>(app, {api: 'v1', path: `/repos/${encodeURIComponent(p.owner.login)}/${encodeURIComponent(p.name)}/compare/${encodeURIComponent(p.default_branch)}...${encodeURIComponent(head)}`, signal: ctl.signal}).catch(() => undefined),
        // Only a fork whose upstream has a branch of that name; its absence is no standing to show.
        online<SyncInfo>(app, {api: 'v1', path: `${forkPath}/sync_fork`, signal: ctl.signal}).catch(() => undefined),
      ]);
      if (ctl.signal.aborted) return;
      setStanding({key, value: {
        upstream: {owner: p.owner.login, name: p.name, defaultBranch: p.default_branch}, branch: fork.default_branch,
        ahead: info?.total_commits ?? 0, behind: sync?.commits_behind ?? 0, syncable: sync?.allowed === true,
      }});
    })().catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [app, owner, repo, forkPath, key]);
  const s = standing?.value;
  if (!s || (!s.ahead && !s.behind)) return null;
  const sync = () => {
    if (syncing || !isOnline) return;
    setSyncing(true);
    onlineWrite(app, {method: 'POST', api: 'v1', path: `${forkPath}/sync_fork`}).then(() => {
      setSyncing(false);
      notify(app, {tone: 'success', title: `Synced ${s.branch} with ${s.upstream.owner}/${s.upstream.name}`});
      setRound((r) => r + 1);
    }, (err: unknown) => {
      setSyncing(false);
      notify(app, {tone: 'danger', title: `${s.branch} was not synced`, description: failureText(err)});
    });
  };
  const why = !isOnline ? onlineOnly('Syncing a fork') : undefined;
  return (
    <Callout title={standingText(s)} actions={<>
      {s.ahead > 0 && (
        <Button size="sm" variant="secondary" asChild>
          <Link {...codeTo(s.upstream.owner, s.upstream.name, compareSplat(s.upstream.defaultBranch, forkHead(owner, repo, s.upstream.owner, s.branch)))} search={{expand: '1'} as never}>
            <Icon icon={GitPullRequestArrow} size="sm"/>Compare &amp; open pull request
          </Link>
        </Button>
      )}
      {s.behind > 0 && writer && s.syncable && (
        <Button size="sm" variant="primary" icon={RefreshCw} aria-disabled={Boolean(why) || syncing} tooltip={why ?? `Fast-forward ${s.branch} to ${s.upstream.owner}/${s.upstream.name}:${s.branch}`} onClick={sync}>
          {syncing ? 'Syncing…' : 'Sync fork'}
        </Button>
      )}
    </>}>
      {s.behind > 0 && writer && !s.syncable ?
        `It has commits of its own, so it cannot be fast-forwarded: merge ${s.upstream.owner}/${s.upstream.name}:${s.branch} into it to catch up.` :
        undefined}
    </Callout>
  );
});
