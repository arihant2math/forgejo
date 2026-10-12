// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Avatar} from '@primer/react';
import {GitCommitIcon} from '@primer/octicons-react';
import type {CommitInfo} from '../../code/source.ts';
import type {ReactNode} from 'react';
import {clsx} from 'clsx';
import {PRIMARY_LINK_HOVER} from '../../app/routerLinks.tsx';

import {Sha, summary} from '../../components/Sha.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import type {RowParts} from './RowList.tsx';

export function CommitRowText({author, children}: {author: string; children: ReactNode}) {
  return <span className="flex min-w-0 items-center gap-2 text-base"><span className={clsx('truncate font-semibold', PRIMARY_LINK_HOVER)}>{children}</span><span className="shrink-0 text-muted">{author}</span></span>;
}

const DAY = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'});

/** GitHub's day header for commit lists, in the reader's time zone. */
export function commitDay(c: Pick<CommitInfo, 'date'>): string {
  const t = Date.parse(c.date);
  return Number.isNaN(t) ? 'Commits' : `Commits on ${DAY.format(t)}`;
}

export function commitRow(c: CommitInfo): RowParts {
  return {
    leading: c.authorAvatar ? <Avatar alt={c.authorName} src={c.authorAvatar} size={20}/> : <span className="inline-flex w-5 items-center justify-center"><GitCommitIcon size={16}/></span>,
    main: <CommitRowText author={c.authorName}>{summary(c.message)}</CommitRowText>,
    trailing: <><Sha sha={c.sha}/><span className="w-12 text-right"><TimeAgo at={c.date}/></span></>,
  };
}

