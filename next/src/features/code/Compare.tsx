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
import type {CodeSource, CompareInfo} from '../../code/source.ts';
import {EmptyState, SectionHeading} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {DiffView} from './DiffView.tsx';
import {useDiff} from './History.tsx';
import {commitRow} from './bits.tsx';
import {refTable, useLoad, useSource} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {RowList} from './RowList.tsx';
import {Unloaded} from './states.tsx';

/**
 * The merge base's candidates: the parents of the new commits that are not new
 * themselves (the commits head and base share where head's history joins
 * base's). One candidate is the merge base; several (base merged into head
 * after forking) are ordered by ancestry, see mergeBase.
 */
export function baseCandidates(info: CompareInfo, base: string): string[] {
  const listed = new Set(info.commits.map((c) => c.sha));
  const out: string[] = [];
  for (const c of info.commits) for (const p of c.parents) if (!listed.has(p) && !out.includes(p)) out.push(p);
  return out.length ? out : [base];
}

/**
 * The merge base of base and head (API v1 has none): the candidate every
 * other candidate is an ancestor of (`compare(c, other)` lists nothing). Each
 * question is a compare of full SHAs: cached, so asked once.
 */
export async function mergeBase(src: CodeSource, repoId: number, base: string, info: CompareInfo): Promise<string> {
  const cands = baseCandidates(info, base);
  if (cands.length === 1) return cands[0] ?? base;
  for (const c of cands) {
    let newest = true;
    for (const o of cands) {
      if (o === c) continue;
      if ((await src.compare(repoId, c, o)).commits.length) {
        newest = false;
        break;
      }
    }
    if (newest) return c;
  }
  return cands[0] ?? base; // criss-cross history: any of them
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
  const mbKey = info.state === 'ready' ? `mergebase:${String(repoId)}:${baseSha}:${headSha}` : undefined;
  const mb = useLoad(mbKey, () => (mbKey ? src.peek<string>(mbKey) : undefined), async () => {
    if (info.state !== 'ready' || !mbKey) throw new Error('no comparison');
    const sha = await mergeBase(src, repoId, baseSha, info.value);
    src.cache.put(mbKey, sha);
    return sha;
  });
  const from = mb.state === 'ready' ? mb.value : undefined;
  const diff = useDiff(repoId, from ?? '', from ? headSha : '');
  if (info.state !== 'ready') return <Unloaded loaded={info} what="This comparison"/>;
  if (!info.value.commits.length) return <EmptyState icon={GitCompare} title="Nothing to compare" description={`${shortSha(headSha)} has no commits that ${shortSha(baseSha)} lacks.`}/>;
  return (
    <>
      <div className="border-b border-border">
        <div className="px-4 pt-3 pb-1"><SectionHeading>{`${String(info.value.total)} ${info.value.total === 1 ? 'commit' : 'commits'}`}</SectionHeading></div>
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={commitRow}
          onOpen={(c) => {
            void navigate(codeTo(owner, repo, `commit/${c.sha}`));
          }}/>
      </div>
      {from && diff.state === 'ready' ?
        <DiffView repoId={repoId} base={from} head={headSha} files={diff.value} scroller={scroller}/> :
        mb.state !== 'ready' && mb.state !== 'loading' ? <Unloaded loaded={mb} what="These changes"/> :
          diff.state !== 'ready' && <Unloaded loaded={diff} what="These changes"/>}
    </>
  );
});
