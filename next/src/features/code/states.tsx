// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a code view shows while its content is not there: a skeleton while it
// loads, "Not available offline" (with what is) when it is not on this
// device, the server's refusal otherwise. Never a spinner.

import {CloudOff, FolderGit2, SearchX, TriangleAlert} from 'lucide-react';
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

/** `action`: the way on from a "Not found" (the list it would be in). */
export const Unloaded = observer(function Unloaded({loaded, what, skeleton, action}: {loaded: Exclude<Loaded<unknown>, {state: 'ready'}>; what: string; skeleton?: ReactNode; action?: ReactNode}) {
  const unreachable = reach(useApp().session?.data.status.connection) === 'unreachable';
  switch (loaded.state) {
    case 'loading':
      return skeleton ?? <div className="flex flex-col gap-2 px-6 py-4" aria-busy><Skeleton className="h-3 w-64"/><Skeleton className="h-3 w-48"/></div>;
    case 'offline':
      return <EmptyState icon={CloudOff} title={unreachable ? 'Can’t reach Forgejo' : 'Not available offline'} description={missingWords(what)[unreachable ? 'unreachable' : 'offline']} action={<AvailableOffline/>}/>;
    case 'error':
      if (loaded.status === 404) return <EmptyState icon={SearchX} title="Not found" description={missingWords(what).notFound} action={action}/>;
      if (loaded.status === 413) return <EmptyState icon={TriangleAlert} title="Too large to show here" description={missingWords(what).tooLarge}/>;
      if (loaded.message === 'signed out' || loaded.message.includes('SignedOut')) return <EmptyState icon={CloudOff} title="Signed out" description="Sign in again (the sync indicator above) to load this."/>;
      return <EmptyState icon={TriangleAlert} title="Could not load" description={loaded.message}/>;
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
    <EmptyState icon={FolderGit2} title="This repository is empty" description="Push a first commit to it from an existing repository:"
      action={<pre className="max-w-full overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 text-left font-mono text-code text-fg select-all">{commands}</pre>}/>
  );
});
