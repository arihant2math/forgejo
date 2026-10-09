// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Compare (`compare/{base}...{head}`): the commits on head that base lacks
// (API v1 by full SHAs, cached) and the changes since they diverged — the
// diff from the oldest such commit's first parent (the merge base for a
// branch that forked from base) to head, as Forgejo's three-dot compare
// shows. Branch and tag names resolve from the pool.

import {Link, useNavigate} from '@tanstack/react-router';
import {ChevronDown, GitBranch, GitCompare, GitPullRequest, Tag} from 'lucide-react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {observer} from 'mobx-react-lite';
import {useRef} from 'react';
import {resolveName} from '../../code/refs.ts';
import type {CodeSource, CompareInfo} from '../../code/source.ts';
import {Button, CommandPopover, EmptyState, Icon, type PickOption, SectionHeading} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {ChangedFiles, type DiffHandle, DiffView} from './DiffView.tsx';
import {useDiff} from './History.tsx';
import {commitRow} from './bits.tsx';
import {refTable, useLoad, useSource} from './hooks.ts';
import {codeTo, useCodeRows} from './nav.tsx';
import type {CommitInfo} from '../../code/source.ts';
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
  // Either side switches to another branch or tag (the other side stays).
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <ComparePick {...props} side="base" value={props.base}/>
      <span className="text-fg-subtle" aria-hidden>…</span>
      <ComparePick {...props} side="head" value={props.head}/>
    </span>
  );
  return (
    <CodeFrame view={props} title={title} controls={<ComparePull {...props}/>}>
      {(scroller) => (base && head ?
        <Compared {...props} baseSha={base} headSha={head} scroller={scroller}/> :
        <EmptyState icon={GitCompare} title="Branch or tag not found" description={`${base ? props.head : props.base} does not exist, or is not on this device.`}/>)}
    </CodeFrame>
  );
});

const ComparePick = observer(function ComparePick({owner, repo, repoId, base, head, side, value}: CodeViewProps & {base: string; head: string; side: 'base' | 'head'; value: string}) {
  const pool = usePool();
  const navigate = useNavigate();
  const refs = refTable(pool, repoId);
  const branches = [...refs.branches.keys()].sort((a, b) => (a === refs.defaultBranch ? -1 : b === refs.defaultBranch ? 1 : a.localeCompare(b)));
  const tags = [...refs.tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const option = (ref: string, tag: boolean): PickOption => ({
    value: `${tag ? 'tag' : 'branch'}:${ref}`, label: ref, group: tag ? 'Tags' : 'Branches', icon: tag ? Tag : GitBranch,
    meta: !tag && ref === refs.defaultBranch ? 'default' : undefined, checked: ref === value,
    onSelect: () => {
      void navigate(codeTo(owner, repo, `compare/${side === 'base' ? ref : base}...${side === 'head' ? ref : head}`));
    },
  });
  return (
    <CommandPopover width="md" label={side === 'base' ? 'Compare from' : 'Compare to'} placeholder="Find a branch or tag…" empty="No branch or tag is on this device."
      options={[...branches.map((b) => option(b, false)), ...tags.map((t) => option(t, true))]}
      trigger={
        <Button size="sm" icon={GitBranch} aria-label={`${side === 'base' ? 'Base' : 'Head'}: ${value}`}>
          <span className="max-w-xs truncate font-mono">{value}</span><Icon icon={ChevronDown} size="sm"/>
        </Button>
      }/>
  );
});

/** The open pull request of these branches, or the classic page that opens one (its form: title, reviewers…). */
const ComparePull = observer(function ComparePull({owner, repo, repoId, base, head}: CodeViewProps & {base: string; head: string}) {
  const pool = usePool();
  const pr = [...pool.model('PullRequest').all()].map((p) => p.data).find((p) => p.base_repo_id === repoId && p.head_repo_id === repoId &&
    p.base_branch === base && p.head_branch === head && pool.model('Issue').get(p.issue_id)?.get('state') === 'open');
  if (pr) {
    return (
      <Button size="sm" variant="ghost" asChild>
        <Link to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}}><Icon icon={GitPullRequest} size="sm"/>Pull request #{pr.number}</Link>
      </Button>
    );
  }
  const branches = refTable(pool, repoId).branches;
  // Nothing to propose: the same branch, or the same commit.
  if (!branches.has(base) || !branches.has(head) || base === head || branches.get(base) === branches.get(head)) return null;
  return <ClassicLink size="sm" variant="primary" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base.split('/').map(encodeURIComponent).join('/')}...${head.split('/').map(encodeURIComponent).join('/')}`}>New pull request</ClassicLink>;
});

const Compared = observer(function Compared(props: CodeViewProps & {base: string; head: string; baseSha: string; headSha: string; scroller: HTMLDivElement | null}) {
  const {owner, repo, repoId, baseSha, headSha, scroller} = props;
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const src = useSource();
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
  const diffRef = useRef<DiffHandle>(null);
  if (info.state !== 'ready') return <Unloaded loaded={info} what="This comparison"/>;
  if (!info.value.commits.length) {
    // Named as the user chose them (refs, not SHAs).
    return <EmptyState icon={GitCompare} title="Nothing to compare" description={baseSha === headSha ?
      `${props.base} and ${props.head} are identical.` : `${props.head} has no commits that ${props.base} lacks.`}/>;
  }
  return (
    <>
      <div className="sticky left-0 w-view border-b border-border">
        <div className="px-4 pt-3 pb-1"><SectionHeading>{`${String(info.value.total)} ${info.value.total === 1 ? 'commit' : 'commits'}`}</SectionHeading></div>
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={commitRow}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/>
      </div>
      {from && diff.state === 'ready' ?
        <>
          <ChangedFiles files={diff.value} diff={diffRef}/>
          <DiffView ref={diffRef} repoId={repoId} base={from} head={headSha} files={diff.value} scroller={scroller}/>
        </> :
        mb.state !== 'ready' && mb.state !== 'loading' ? <Unloaded loaded={mb} what="These changes"/> :
          diff.state !== 'ready' && <Unloaded loaded={diff} what="These changes"/>}
    </>
  );
});
