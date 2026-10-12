// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Upstreams need not be synced locally, so fork standing requires an online API read.
import {Banner} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {failureText, online, onlineWrite} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {codeTo} from '../code/nav.tsx';
import {compareSplat, forkHead} from '../code/proposal.ts';
import {GitPullRequestIcon, SyncIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Tooltip} from '@primer/react';
import {RouterLinkButton} from '../../app/routerLinks.tsx';

interface SyncInfo {
  allowed?: boolean;
  commits_behind?: number;
}

interface Standing {
  upstream: {owner: string; name: string; defaultBranch: string};
  branch: string;
  ahead: number;
  behind: number;
  syncable: boolean;
}

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
        // An upstream without a matching branch has no standing to show.
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
    <Banner title={standingText(s)} primaryAction={<>
      {s.ahead > 0 && (
        <RouterLinkButton size="small" leadingVisual={GitPullRequestIcon} {...codeTo(s.upstream.owner, s.upstream.name, compareSplat(s.upstream.defaultBranch, forkHead(owner, repo, s.upstream.owner, s.branch)))} search={{expand: '1'} as never}>Compare &amp; open pull request
          </RouterLinkButton>
      )}
      {s.behind > 0 && writer && s.syncable && (
        <Tooltip text={why ?? `Fast-forward ${s.branch} to ${s.upstream.owner}/${s.upstream.name}:${s.branch}`}><Button variant="primary" size="small" leadingVisual={SyncIcon} type="button" inactive={Boolean(why)} disabled={syncing} onClick={sync}>
          {syncing ? 'Syncing…' : 'Sync fork'}
        </Button></Tooltip>
      )}
    </>} description={
      s.behind > 0 && writer && !s.syncable ?
        `It has commits of its own, so it cannot be fast-forwarded: merge ${s.upstream.owner}/${s.upstream.name}:${s.branch} into it to catch up.` :
        undefined
    }/>
  );
});

