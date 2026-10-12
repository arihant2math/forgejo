// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useMemo} from 'react';
import type {CommitInfo} from '../../code/source.ts';
import {useApp} from '../../app/store.ts';
import {branchByName, useLoad, useSource, warmFile} from './hooks.ts';
import {codeSplat, type RefKind, type Resolved} from '../../code/refs.ts';
import type {APITree, APITreeEntry} from '../../protocol/types.gen.ts';
import {usePool} from '../issues/cells.tsx';
import {Ago, Sha, summary} from './bits.tsx';
import {codeTo, useCodeRows} from './nav.tsx';
import {RowList, type RowParts} from './RowList.tsx';
import {Blankslate} from '@primer/react/experimental';
import {FileIcon, FileSymlinkFileIcon, FileDirectoryFillIcon, FileSubmoduleIcon, GitBranchIcon, GitCommitIcon, TagIcon} from '@primer/octicons-react';
import {PrimaryLink} from '../../app/routerLinks.tsx';

const ENTRY_ICON = {tree: FileDirectoryFillIcon, blob: FileIcon, symlink: FileSymlinkFileIcon, commit: FileSubmoduleIcon} as const;

export function formatSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Directories first, then git byte order rather than locale order. */
export function treeOrder(entries: readonly APITreeEntry[]): APITreeEntry[] {
  return [...entries].sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function entryParts(e: APITreeEntry): RowParts {
  return {
    leading: (() => {const EntryIcon = ENTRY_ICON[e.type as keyof typeof ENTRY_ICON] ?? FileIcon; return <EntryIcon size={16}/>;})(),
    main: e.name,
    trailing: e.type === 'blob' ? <span className="tabular-nums">{formatSize(e.size)}</span> : undefined,
  };
}

export const RefCommit = observer(function RefCommit({owner, repo, repoId, kind, name, sha, showRef = true}: {
  owner: string; repo: string; repoId: number; kind: RefKind; name: string; sha: string; showRef?: boolean;
}) {
  const pool = usePool();
  const b = kind === 'branch' ? branchByName(pool, repoId).get(name)?.data : undefined;
  const commit = b?.commit_id ?? sha;
  const src = useSource();
  const key = `commit:${String(repoId)}:${commit}`;
  const info = useLoad(b ? undefined : key, () => src.peek<CommitInfo>(key), () => src.commit(repoId, commit));
  const message = b?.commit_message ?? (info.state === 'ready' ? info.value.message : undefined);
  const date = b?.commit_time ?? (info.state === 'ready' ? info.value.date : undefined);
  return (
    <>
      {showRef && <>
        {kind === 'tag' ? <TagIcon size={16}/> : kind === 'commit' ? <GitCommitIcon size={16}/> : <GitBranchIcon size={16}/>}
        {kind === 'commit' ? <Sha sha={sha}/> : <span className="font-mono text-default">{name}</span>}
      </>}
      {message !== undefined ? <>
        <span className="min-w-0 truncate"><PrimaryLink {...codeTo(owner, repo, `commit/${commit}`)} className="min-w-0 truncate">{summary(message)}</PrimaryLink></span>
        {date !== undefined && <span className="ml-auto shrink-0 text-sm text-muted tabular-nums"><Ago at={date}/></span>}
      </> : kind !== 'commit' && <PrimaryLink {...codeTo(owner, repo, `commit/${commit}`)} className="min-w-0 truncate"><Sha sha={commit}/></PrimaryLink>}
    </>
  );
});

/** A directory's entries as a virtualized list against `scroller`, prefetching what the pointer or cursor rests on. */
export function DirEntries({owner, repo, repoId, at, tree, scroller}: {owner: string; repo: string; repoId: number; at: Resolved; tree: APITree; scroller: HTMLElement | null}) {
  const pathOf = (e: APITreeEntry) => (at.path ? `${at.path}/${e.name}` : e.name);
  const rows = useCodeRows<APITreeEntry>(owner, repo, (e) => codeSplat('src', at, pathOf(e)));
  const src = useSource();
  const {config: {base}} = useApp();
  const entries = useMemo(() => treeOrder(tree.entries), [tree]);
  if (!entries.length) return <Blankslate><Blankslate.Visual><FileDirectoryFillIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Empty directory</Blankslate.Heading></Blankslate>;
  return (
    <RowList items={entries} scroller={scroller} label="Files" keyOf={(e) => e.name}
      row={entryParts}
      onOpen={rows.onOpen} linkOf={rows.linkOf}
      // Prefetch at idle priority so intent never delays visible content.
      onIntent={(e) => {
        const p = pathOf(e);
        if (e.type === 'tree') void src.tree(repoId, at.sha, p).catch(() => undefined);
        else if (e.type === 'blob') warmFile(src, base, repoId, e.sha, p, e.size);
      }}/>
  );
}
