// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A directory's listing, one look on the repository's Overview and in the
// Code tab: a panel headed by the ref's latest commit, its entries in git's
// order (directories first), each with its icon and size.

import {Link} from '@tanstack/react-router';
import {File, FileSymlink, Folder, FolderGit2, GitBranch, GitCommitHorizontal, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RefKind} from '../../code/refs.ts';
import type {APITreeEntry} from '../../protocol/types.gen.ts';
import {Icon, Panel, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {Ago, Sha, summary} from './bits.tsx';
import type {RowParts} from './RowList.tsx';

const ENTRY_ICON = {tree: Folder, blob: File, symlink: FileSymlink, commit: FolderGit2} as const;

export function formatSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Directories first, then git's order (byte order: "projection.go" before "projection_test.go"). */
export function treeOrder(entries: readonly APITreeEntry[]): APITreeEntry[] {
  return [...entries].sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** An entry as a row: its icon, its name, a file's size. */
export function entryParts(e: APITreeEntry): RowParts {
  return {
    leading: <Icon icon={ENTRY_ICON[e.type as keyof typeof ENTRY_ICON]} size="sm"/>,
    main: e.name,
    trailing: e.type === 'blob' ? <span className="tabular-nums">{formatSize(e.size)}</span> : undefined,
  };
}

/** The ref and its latest commit (a branch's, from the pool), as a files panel's header. */
export const RefCommit = observer(function RefCommit({owner, repo, repoId, kind, name, sha}: {owner: string; repo: string; repoId: number; kind: RefKind; name: string; sha: string}) {
  const pool = usePool();
  const b = kind === 'branch' ? [...pool.model('Branch').by('repo_id', repoId)].find((x) => x.get('name') === name && !x.get('is_deleted'))?.data : undefined;
  const commit = b?.commit_id ?? sha;
  return (
    <>
      <Icon icon={kind === 'tag' ? Tag : kind === 'commit' ? GitCommitHorizontal : GitBranch} size="sm"/>
      {kind === 'commit' ? <Sha sha={sha}/> : <span className="font-mono text-fg">{name}</span>}
      {b ? <>
        <span className="min-w-0 truncate"><TextLink><Link to="/-/next/code/$owner/$repo/$" params={{owner, repo, _splat: `commit/${commit}/-`}}>{summary(b.commit_message)}</Link></TextLink></span>
        <span className="shrink-0 tabular-nums"><Ago at={b.commit_time}/></span>
      </> : kind !== 'commit' && <TextLink><Link to="/-/next/code/$owner/$repo/$" params={{owner, repo, _splat: `commit/${commit}/-`}}><Sha sha={commit}/></Link></TextLink>}
    </>
  );
});

/** A directory's listing panel (the header: RefCommit; actions: e.g. "Browse code"). */
export function FilesPanel({title, actions, children}: {title: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return <Panel label="Files" title={title} actions={actions}>{children}</Panel>;
}
