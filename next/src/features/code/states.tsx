// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useApp, usePool} from '../../app/store.ts';
import {httpsCloneUrl} from '../../code/clone.ts';
import type {ReactNode} from 'react';
import type {Unready} from '../../app/resource.ts';
import {LoadState} from '../../components/LoadState.tsx';
import {FileOperations} from './FileOperations.tsx';
import {FileSubmoduleIcon} from '@primer/octicons-react';
import {Blankslate} from '@primer/react/experimental';

/** A page body's loading, offline and failure states. */
export function Unloaded({loaded, what, skeleton, action}: {loaded: Unready; what: string; skeleton?: ReactNode; action?: ReactNode}) {
  return <LoadState res={loaded} what={what} page skeleton={skeleton} action={action}/>;
}

export const EmptyRepo = observer(function EmptyRepo({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const r = usePool().model('Repository').get(repoId)?.data;
  if (!r?.empty) return null;
  const branch = r.default_branch || 'main';
  const commands = `git remote add origin ${httpsCloneUrl(app.config.app_url, owner, repo)}\ngit push -u origin ${branch}`;
  return (
    <Blankslate spacious><Blankslate.Visual><FileSubmoduleIcon size={24}/></Blankslate.Visual><Blankslate.Heading>This repository is empty</Blankslate.Heading><Blankslate.Description>Push a first commit to it from an existing repository:</Blankslate.Description>{<FileOperations owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha: '', path: ''}}><pre className="max-w-full overflow-x-auto rounded-md border border-default bg-inset px-4 py-2 text-left font-mono text-code text-default select-all">{commands}</pre></FileOperations>}</Blankslate>
  );
});
