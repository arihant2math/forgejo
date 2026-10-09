// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Small pieces every code view shares (one look each): a short SHA, a
// relative time, a commit as a list row.

import {shortSha} from '../../code/refs.ts';
import type {CommitInfo} from '../../code/source.ts';
import {Avatar} from '../../ui/index.ts';
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

/** A commit as a RowList row: author, summary, SHA, time. */
export function commitRow(c: CommitInfo): RowParts {
  return {
    leading: <Avatar name={c.authorName} src={c.authorAvatar === '' ? undefined : c.authorAvatar} size="sm"/>,
    main: <>{summary(c.message)} <span className="text-fg-subtle">{c.authorName}</span></>,
    trailing: <><Sha sha={c.sha}/><Ago at={c.date}/></>,
  };
}

