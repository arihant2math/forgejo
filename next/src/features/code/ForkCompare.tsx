// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useEffect, useRef, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {online} from '../../app/api.ts';
import {sitePath} from '../../app/config.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {netSignal} from '../../sync/net.ts';
import {parseDiff, type DiffFile} from '../../code/diff.ts';
import {Callout} from '../../ui/index.ts';
import {ChangedFiles, DiffView, type DiffHandle} from './DiffView.tsx';
import {NewPull} from './NewPull.tsx';
import type {CodeViewProps} from './CodePage.tsx';
import {forkHead} from './proposal.ts';
import {Button} from '@primer/react';
import {RouterLinkButton} from '../../app/RouterLinkButton.tsx';
import {Blankslate} from '@primer/react/experimental';

export const ForkCompare = observer(function ForkCompare(props: CodeViewProps & {base: string; head: string; open: boolean; scroller: HTMLDivElement | null}) {
  const app = useApp();
  const session = useSession();
  const [open, setOpen] = useState(props.open);
  const [result, setResult] = useState<{files: DiffFile[]; total: number; title: string; repoId: number; baseSha: string; headSha: string}>();
  const [error, setError] = useState('');
  const diff = useRef<DiffHandle>(null);
  const [headRepo, branch] = props.head.split(':');
  const [headOwner, headName] = (headRepo ?? '').split('/');
  const existing = [...session.data.pool.model('PullRequest').all()].find((p) => p.get('base_repo_id') === props.repoId && p.get('base_branch') === props.base && p.get('head_branch') === branch && (p.get('head_repo_id') === result?.repoId || (session.data.pool.model('Repository').get(p.get('head_repo_id'))?.get('owner_name') === headOwner && (!headName || session.data.pool.model('Repository').get(p.get('head_repo_id'))?.get('name') === headName))) && session.data.pool.model('Issue').get(p.get('issue_id'))?.get('state') === 'open');
  const connected = reach(session.data.status.connection) === 'online';
  useEffect(() => {
    if (!connected) return;
    const ctl = new AbortController();
    setResult(undefined);
    setError('');
    const path = `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repo)}/compare/${encodeURIComponent(props.base)}...${encodeURIComponent(props.head)}`;
    void (async () => {
      const info = await online<{total_commits: number; merge_base: string; head_commit_id: string; head_repo_id: number; commits: {commit: {message: string}}[]}>(app, {api: 'v1', path, signal: ctl.signal});
      const token = await session.auth.token();
      const raw = await fetch(sitePath(app.config, `/api/v1${path}?diff=true`), {signal: netSignal(15_000, ctl.signal), credentials: 'omit', redirect: 'manual', headers: {Authorization: `Bearer ${token}`}});
      if (!raw.ok || !info) throw new Error('Could not compare these branches.');
      const files = parseDiff(await raw.text());
      if (!ctl.signal.aborted) setResult({files, total: info.total_commits, title: info.commits[0]?.commit.message.split('\n')[0] ?? props.head, repoId: info.head_repo_id, baseSha: info.merge_base, headSha: info.head_commit_id});
    })().catch((err: unknown) => { if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : 'Could not compare these branches.'); });
    return () => { ctl.abort(); };
  }, [app, props.owner, props.repo, props.base, props.head, connected, session]);
  if (!connected) return <Callout title="Online only">Comparing forks and opening pull requests requires a connection.</Callout>;
  if (error) return <Callout tone="danger" title="Comparison failed">{error}</Callout>;
  if (!result) return <Blankslate><Blankslate.Heading>Loading comparison…</Blankslate.Heading></Blankslate>;
  if (!result.total) return <Blankslate><Blankslate.Heading>Nothing to compare</Blankslate.Heading><Blankslate.Description>This branch has no commits that the base lacks.</Blankslate.Description></Blankslate>;
  return <>
    <div className="sticky left-0 w-view border-b border-default px-4 py-3">
      {existing ? <RouterLinkButton to="/$owner/$repo/pulls/$index" params={{owner: props.owner, repo: props.repo, index: String(existing.get('number'))}}>Pull request #{existing.get('number')}</RouterLinkButton> : open ? <NewPull owner={props.owner} repo={props.repo} repoId={props.repoId} base={props.base} head={props.head} outlook={{kind: 'unknown', behind: 0}} defaults={{title: result.title, body: ''}} onCancel={() => { setOpen(false); }}/>
        : <Button variant="primary" type="button" onClick={() => { setOpen(true); }}>New pull request</Button>}
    </div>
    <ChangedFiles files={result.files} diff={diff}/>
    <DiffView ref={diff} repoId={result.repoId} base={result.baseSha} head={result.headSha} files={result.files} scroller={props.scroller}/>
  </>;
});

export interface ForkChoice {id: number; name: string; owner: {login: string}}

/** A fork's branch as a comparison's head: `value` is the head (forkHead), `words` lets `owner:branch` find it. */
export interface ForkBranch {value: string; label: string; group: string; words: string}

/**
 * The branches of the forks of owner/repo (`only`: of the forks this login owns), grouped by fork. Forks are not
 * synced to the device: API v1, online.
 */
export async function forkBranches(app: ReturnType<typeof useApp>, owner: string, repo: string, only?: string): Promise<ForkBranch[]> {
  const options: ForkBranch[] = [];
  for (let page = 1; ; page++) {
    const forks = await online<ForkChoice[]>(app, {api: 'v1', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks?limit=50&page=${String(page)}`});
    if (!forks) break;
    for (const fork of forks) {
      if (only !== undefined && fork.owner.login.toLowerCase() !== only.toLowerCase()) continue;
      for (let branchPage = 1; ; branchPage++) {
        const branches = await online<{name: string}[]>(app, {api: 'v1', path: `/repos/${encodeURIComponent(fork.owner.login)}/${encodeURIComponent(fork.name)}/branches?limit=50&page=${String(branchPage)}`});
        if (!branches) break;
        options.push(...branches.map((b) => {
          const value = forkHead(fork.owner.login, fork.name, owner, b.name);
          return {value, label: b.name, group: `${fork.owner.login}/${fork.name}`, words: `${value} ${fork.owner.login}/${fork.name}`};
        }));
        if (branches.length < 50) break;
      }
    }
    if (forks.length < 50) break;
  }
  return options;
}
