// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Compare (`compare/{base}...{head}`): the commits on head that base lacks
// (API v1 by full SHAs, cached) and the changes since they diverged — the
// diff from the oldest such commit's first parent (the merge base for a
// branch that forked from base) to head, as Forgejo's three-dot compare
// shows. Branch and tag names resolve from the pool.

import {useNavigate} from '@tanstack/react-router';
import {GitCompare} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {resolveName, shortSha} from '../../code/refs.ts';
import type {CompareInfo} from '../../code/source.ts';
import {Avatar, EmptyState, SectionHeading} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {DiffView} from './DiffView.tsx';
import {summary, useDiff} from './History.tsx';
import {refTable, useLoad, useSource} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {RowList} from './RowList.tsx';
import {Unloaded} from './states.tsx';

/** The commit the compared head forked from: the oldest new commit's first parent (else base itself). */
export function forkPoint(info: CompareInfo, base: string): string {
  const oldest = info.commits.reduce<CompareInfo['commits'][number] | undefined>((o, c) => (!o || c.date < o.date ? c : o), undefined);
  return oldest?.parents[0] ?? base;
}

export const CompareView = observer(function CompareView(props: CodeViewProps & {base: string; head: string}) {
  const pool = usePool();
  const refs = refTable(pool, props.repoId);
  const base = resolveName(refs, props.base);
  const head = resolveName(refs, props.head);
  const title = <><span className="font-mono">{props.base}</span> … <span className="font-mono">{props.head}</span></>;
  return (
    <CodeFrame view={props} title={title}>
      {(scroller) => (base && head ?
        <Compared {...props} baseSha={base} headSha={head} scroller={scroller}/> :
        <EmptyState icon={GitCompare} title="Branch or tag not found" description={`${base ? props.head : props.base} does not exist, or is not on this device.`}/>)}
    </CodeFrame>
  );
});

const Compared = observer(function Compared({owner, repo, repoId, baseSha, headSha, scroller}: CodeViewProps & {baseSha: string; headSha: string; scroller: HTMLDivElement | null}) {
  const src = useSource();
  const navigate = useNavigate();
  const key = `compare:${String(repoId)}:${baseSha}:${headSha}`;
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(repoId, baseSha, headSha));
  const from = info.state === 'ready' ? forkPoint(info.value, baseSha) : undefined;
  const diff = useDiff(repoId, from ?? '', from ? headSha : '');
  if (info.state !== 'ready') return <Unloaded loaded={info} what="This comparison"/>;
  if (!info.value.commits.length) return <EmptyState icon={GitCompare} title="Nothing to compare" description={`${shortSha(headSha)} has no commits that ${shortSha(baseSha)} lacks.`}/>;
  return (
    <>
      <div className="border-b border-border">
        <div className="px-4 pt-3 pb-1"><SectionHeading>{`${String(info.value.total)} ${info.value.total === 1 ? 'commit' : 'commits'}`}</SectionHeading></div>
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={(c) => ({
            leading: <Avatar name={c.authorName} size="sm"/>,
            main: summary(c.message),
            trailing: <><span className="font-mono">{shortSha(c.sha)}</span><time dateTime={c.date} title={fullDate(c.date)}>{ago(c.date)}</time></>,
          })}
          onOpen={(c) => {
            void navigate(codeTo(owner, repo, `commit/${c.sha}`));
          }}/>
      </div>
      {from && diff.state === 'ready' ?
        <DiffView repoId={repoId} base={from} head={headSha} files={diff.value} scroller={scroller}/> :
        diff.state !== 'ready' && <Unloaded loaded={diff} what="These changes"/>}
    </>
  );
});
