// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A commit's text and standing, shared by the commit page and the commit
// rows of comparisons and histories: issue and pull request references in a
// message ("#107", "Closes #25", "acme/atlas#3") as visible links, and the
// branches and tags that contain a commit (which release has a fix) — the
// classic commit page's load-branches-and-tags, from the sync API (refs
// move: asked for online, not cached).
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {useApp} from '../../app/store.ts';
import {online} from '../../app/api.ts';
import type {CommitInfo} from '../../code/source.ts';
import type {APICommitRefs} from '../../protocol/types.gen.ts';
import {Icon, TextLink} from '../../ui/index.ts';
import {commitRow, summary} from './bits.tsx';
import {useLoad} from './hooks.ts';
import {CodeLink} from './nav.tsx';
import type {RowParts} from './RowList.tsx';
import {GitBranchIcon, TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

/** A piece of a message: text, or a reference to issue `index` of `repo` (owner/name; undefined: this repository). */
export type MessagePart = {text: string} | {ref: string; repo: string | undefined; index: string};

/**
 * A message cut at its issue references: `#12`, and `owner/repo#12` (another repository), not inside a word, a path
 * or a URL (`a#1`, `/x#1`, `page#12`), as Forgejo's renderer finds them.
 */
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

/**
 * A commit message (or its summary) with its references as links to the issues (an issue page shows a pull request
 * too). `inRow`: inside a row that opens on click — a reference opens itself, not the row.
 */
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

/** commitRow with the summary's references as links (the comparisons' and histories' rows). */
export function linkedCommitRow(owner: string, repo: string): (c: CommitInfo) => RowParts {
  return (c) => ({
    ...commitRow(c),
    main: <><CommitMessage owner={owner} repo={repo} text={summary(c.message)} inRow/> <span className="text-muted">{c.authorName}</span></>,
  });
}

/** How many of each kind are shown before "Show all". */
const SHOWN = 8;

/** The branches and tags that contain a commit (full SHA): which release has it. Online; nothing while loading. */
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
      <span className="flex items-center gap-1"><Icon icon={kind === 'tag' ? TagIcon : GitBranchIcon} size="sm"/>{`In ${String(names.length)} ${what}:`}</span>
      {shown.map((n) => (
        <TextLink key={n} accent><CodeLink owner={owner} repo={repo} to={`src/${kind}/${n}`}><span className="font-mono">{n}</span></CodeLink></TextLink>
      ))}
      {names.length > shown.length && <Button variant="invisible" size="small" type="button" onClick={() => {
        setAll(true);
      }}>{`Show all ${String(names.length)}`}</Button>}
    </p>
  );
}
