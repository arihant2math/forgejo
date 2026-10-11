// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a code view shows while its content is not there: a skeleton while it
// loads, "Not available offline" (with what is) when it is not on this
// device, the server's refusal otherwise. Never a spinner.
import {observer} from 'mobx-react-lite';
import {useApp} from '../../app/store.ts';
import {reach} from '../../app/online.ts';
import {httpsCloneUrl} from '../../code/clone.ts';
import {usePool} from '../issues/cells.tsx';
import type {ReactNode} from 'react';
import {AvailableOffline} from '../../app/Available.tsx';
import {missingWords} from '../../app/Missing.tsx';
import {EmptyState, Skeleton} from '../../ui/index.ts';
import type {Loaded} from './hooks.ts';
import {FileOperations} from './FileOperations.tsx';
import {CloudOfflineIcon, FileSubmoduleIcon, RedoIcon, SearchIcon, AlertIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';

/** `action`: the way on from a "Not found" (the list it would be in). */
export const Unloaded = observer(function Unloaded({loaded, what, skeleton, action}: {loaded: Exclude<Loaded<unknown>, {state: 'ready'}>; what: string; skeleton?: ReactNode; action?: ReactNode}) {
  const r = reach(useApp().session?.data.status.connection);
  const retry = loaded.state !== 'loading' && loaded.retry ? <Button type="button" onClick={loaded.retry}><RedoIcon size={12} className="shrink-0"/>Retry</Button> : undefined;
  switch (loaded.state) {
    case 'loading':
      return skeleton ?? <div className="flex flex-col gap-2 px-6 py-4" aria-busy><Skeleton className="h-3 w-64"/><Skeleton className="h-3 w-48"/></div>;
    case 'offline':
      // Connected, yet the request got no answer (a dropped connection, a timeout): not "offline" — said, with a Retry.
      if (r === 'online') return <EmptyState icon={AlertIcon} title="Could not load" description={`${what} could not be loaded: the request to Forgejo failed.`} action={retry}/>;
      return <EmptyState icon={CloudOfflineIcon} title={r === 'unreachable' ? 'Can’t reach Forgejo' : 'Not available offline'} description={missingWords(what)[r]}
        action={<span className="flex flex-col items-center gap-3">{r === 'unreachable' && retry}<AvailableOffline/></span>}/>;
    case 'error':
      if (loaded.status === 404) return <EmptyState icon={SearchIcon} title="Not found" description={missingWords(what).notFound} action={action}/>;
      if (loaded.status === 413) return <EmptyState icon={AlertIcon} title="Too large to show here" description={missingWords(what).tooLarge}/>;
      if (loaded.message === 'signed out' || loaded.message.includes('SignedOut')) return <EmptyState icon={CloudOfflineIcon} title="Signed out" description="Sign in again (the sync indicator above) to load this."/>;
      return <EmptyState icon={AlertIcon} title="Could not load" description={loaded.message} action={retry}/>;
  }
});

/**
 * An empty repository (no commit yet), the same on every code tab: what to push and where, never a missing branch.
 * undefined when the repository is not empty (the caller shows its own content or state).
 */
export const EmptyRepo = observer(function EmptyRepo({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const r = usePool().model('Repository').get(repoId)?.data;
  if (!r?.empty) return null;
  const branch = r.default_branch || 'main';
  const commands = `git remote add origin ${httpsCloneUrl(app.config.app_url, owner, repo)}\ngit push -u origin ${branch}`;
  return (
    <EmptyState icon={FileSubmoduleIcon} title="This repository is empty" description="Push a first commit to it from an existing repository:"
      action={<FileOperations owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha: '', path: ''}}><pre className="max-w-full overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 text-left font-mono text-code text-fg select-all">{commands}</pre></FileOperations>}/>
  );
});
