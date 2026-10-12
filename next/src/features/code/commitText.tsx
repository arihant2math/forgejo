// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Containing refs can move, so query them online without caching.
import {observer} from 'mobx-react-lite';
import {BranchName} from '@primer/react';
import {Link as PrimerLink} from '@primer/react';
import {useState} from 'react';
import {useApp} from '../../app/store.ts';
import {online} from '../../app/api.ts';
import type {CommitInfo} from '../../code/source.ts';
import type {APICommitRefs} from '../../protocol/types.gen.ts';

import {commitRow, CommitRowText, summary} from './bits.tsx';
import {useLoad} from './hooks.ts';
import {CodeLink} from './nav.tsx';
import type {RowParts} from './RowList.tsx';
import {GitBranchIcon, TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

/** Undefined repo means this repository; otherwise it is owner/name. */
export type MessagePart = {text: string} | {ref: string; repo: string | undefined; index: string};

/** Match issue references outside words, paths, and URLs, as Forgejo does. */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /(?<![\w/#.:-])((?:([\w.-]+\/[\w.-]+))?#(\d{1,9}))(?!\w)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index;
    if (at > last) parts.push({text: text.slice(last, at)});
    parts.push({ref: m[1] ?? '', repo: m[2], index: m[3] ?? ''});
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({text: text.slice(last)});
  return parts;
}

/** inRow prevents reference clicks from opening the enclosing commit row. */
export function CommitMessage({owner, repo, text, inRow = false}: {owner: string; repo: string; text: string; inRow?: boolean}) {
  return (
    <>
      {messageParts(text).map((p, i) => {
        if ('text' in p) return p.text;
        const [o, r] = p.repo ? p.repo.split('/') : [owner, repo];
        return (
          <RouterLink key={i} to="/$owner/$repo/issues/$index" params={{owner: o ?? owner, repo: r ?? repo, index: p.index}} onClick={inRow ? (e) => {
              e.stopPropagation();
            } : undefined} className="min-w-0 truncate">{p.ref}</RouterLink>
        );
      })}
    </>
  );
}

export function linkedCommitRow(owner: string, repo: string): (c: CommitInfo) => RowParts {
  return (c) => ({
    ...commitRow(c),
    main: <CommitRowText author={c.authorName}><CommitMessage owner={owner} repo={repo} text={summary(c.message)} inRow/></CommitRowText>,
  });
}

const SHOWN = 8;

export const ContainedIn = observer(function ContainedIn({owner, repo, repoId, sha}: {owner: string; repo: string; repoId: number; sha: string}) {
  const app = useApp();
  const refs = useLoad(`refs:${String(repoId)}:${sha}`, () => undefined,
    async () => (await online<APICommitRefs>(app, {api: 'sync', path: `/repos/${String(repoId)}/refs/${sha}`})) ?? {branches: [], tags: []});
  if (refs.state === 'loading') return null;
  if (refs.state !== 'ready') {
    return <p className="text-sm text-muted">{refs.state === 'offline' ? 'The branches and tags that contain this commit are loaded online.' : 'The branches and tags that contain this commit could not be loaded.'}</p>;
  }
  const {branches, tags} = refs.value;
  if (!branches.length && !tags.length) return <p className="text-sm text-muted">No branch or tag contains this commit.</p>;
  return (
    <div aria-label="Contained in" className="flex flex-col gap-1 text-sm text-muted">
      {tags.length > 0 && <RefList owner={owner} repo={repo} kind="tag" names={tags}/>}
      {branches.length > 0 && <RefList owner={owner} repo={repo} kind="branch" names={branches}/>}
    </div>
  );
});

function RefList({owner, repo, kind, names}: {owner: string; repo: string; kind: 'branch' | 'tag'; names: readonly string[]}) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, SHOWN);
  const what = kind === 'tag' ? (names.length === 1 ? 'tag' : 'tags') : (names.length === 1 ? 'branch' : 'branches');
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1">{kind === 'tag' ? <TagIcon size={16}/> : <GitBranchIcon size={16}/>}{`In ${String(names.length)} ${what}:`}</span>
      {shown.map((n) => (
        <PrimerLink as={CodeLink} key={n} owner={owner} repo={repo} to={`src/${kind}/${n}`}><BranchName as="span">{n}</BranchName></PrimerLink>
      ))}
      {names.length > shown.length && <Button variant="invisible" size="small" type="button" onClick={() => {
        setAll(true);
      }}>{`Show all ${String(names.length)}`}</Button>}
    </p>
  );
}
