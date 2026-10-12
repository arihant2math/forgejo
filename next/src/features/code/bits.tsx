// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Small pieces every code view shares (one look each): a short SHA, a
// relative time, a commit as a list row.

import {shortSha} from '../../code/refs.ts';
import {Avatar} from '@primer/react';
import {GitCommitIcon} from '@primer/octicons-react';
import type {CommitInfo} from '../../code/source.ts';
import type {ReactNode} from 'react';

import {ago, fullDate} from '../issues/format.ts';
import type {RowParts} from './RowList.tsx';

/** A commit SHA, shortened for display (the full one on hover). */
export function Sha({sha}: {sha: string}) {
  return <span className="font-mono tabular-nums" title={sha}>{shortSha(sha)}</span>;
}

/** A time, relative ("3 d"), the full date on hover. */
export function Ago({at}: {at: string}) {
  return <time dateTime={at} title={fullDate(at)}>{ago(at)}</time>;
}

/** The first line of a commit message. */
export function summary(message: string): string {
  const nl = message.indexOf('\n');
  return nl < 0 ? message : message.slice(0, nl);
}

/** Shared primary/identity typography, matching the pull-request commit list. */
export function CommitRowText({author, children}: {author: string; children: ReactNode}) {
  return <span className="flex min-w-0 items-center gap-2 text-base"><span className="truncate font-semibold hover:text-accent hover:underline">{children}</span><span className="shrink-0 text-muted">{author}</span></span>;
}

/** A commit as a RowList row: author, summary, SHA, time. */
export function commitRow(c: CommitInfo): RowParts {
  return {
    leading: c.authorAvatar ? <Avatar alt={c.authorName} src={c.authorAvatar} size={20}/> : <span className="inline-flex w-5 items-center justify-center"><GitCommitIcon size={16}/></span>,
    main: <CommitRowText author={c.authorName}>{summary(c.message)}</CommitRowText>,
    trailing: <><Sha sha={c.sha}/><span className="w-12 text-right"><Ago at={c.date}/></span></>,
  };
}

