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
import type {Loaded} from './hooks.ts';
import {FileOperations} from './FileOperations.tsx';
import {CloudOfflineIcon, FileSubmoduleIcon, RedoIcon, SearchIcon, AlertIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {SkeletonBox, Blankslate} from '@primer/react/experimental';

/** `action`: the way on from a "Not found" (the list it would be in). */
export const Unloaded = observer(function Unloaded({loaded, what, skeleton, action}: {loaded: Exclude<Loaded<unknown>, {state: 'ready'}>; what: string; skeleton?: ReactNode; action?: ReactNode}) {
  const r = reach(useApp().session?.data.status.connection);
  const retry = loaded.state !== 'loading' && loaded.retry ? <Button type="button" onClick={loaded.retry}><RedoIcon size={12} className="shrink-0"/>Retry</Button> : undefined;
  switch (loaded.state) {
    case 'loading':
      return skeleton ?? <div className="flex flex-col gap-2 px-6 py-4" aria-busy><SkeletonBox className="h-3 w-64"/><SkeletonBox className="h-3 w-48"/></div>;
    case 'offline':
      // Connected, yet the request got no answer (a dropped connection, a timeout): not "offline" — said, with a Retry.
      if (r === 'online') return <Blankslate><Blankslate.Visual><AlertIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Could not load</Blankslate.Heading><Blankslate.Description>{`${what} could not be loaded: the request to Forgejo failed.`}</Blankslate.Description>{retry}</Blankslate>;
      return <Blankslate><Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{r === 'unreachable' ? 'Can’t reach Forgejo' : 'Not available offline'}</Blankslate.Heading><Blankslate.Description>{missingWords(what)[r]}</Blankslate.Description>{<span className="flex flex-col items-center gap-3">{r === 'unreachable' && retry}<AvailableOffline/></span>}</Blankslate>;
    case 'error':
      if (loaded.status === 404) return <Blankslate><Blankslate.Visual><SearchIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Not found</Blankslate.Heading><Blankslate.Description>{missingWords(what).notFound}</Blankslate.Description>{action}</Blankslate>;
      if (loaded.status === 413) return <Blankslate><Blankslate.Visual><AlertIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Too large to show here</Blankslate.Heading><Blankslate.Description>{missingWords(what).tooLarge}</Blankslate.Description></Blankslate>;
      if (loaded.message === 'signed out' || loaded.message.includes('SignedOut')) return <Blankslate><Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Signed out</Blankslate.Heading><Blankslate.Description>Sign in again (the sync indicator above) to load this.</Blankslate.Description></Blankslate>;
      return <Blankslate><Blankslate.Visual><AlertIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Could not load</Blankslate.Heading><Blankslate.Description>{loaded.message}</Blankslate.Description>{retry}</Blankslate>;
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
    <Blankslate><Blankslate.Visual><FileSubmoduleIcon size={24}/></Blankslate.Visual><Blankslate.Heading>This repository is empty</Blankslate.Heading><Blankslate.Description>Push a first commit to it from an existing repository:</Blankslate.Description>{<FileOperations owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha: '', path: ''}}><pre className="max-w-full overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 text-left font-mono text-code text-fg select-all">{commands}</pre></FileOperations>}</Blankslate>
  );
});
