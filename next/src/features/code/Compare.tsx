// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Compare (`compare/{base}...{head}`, `compare/{head}`, `compare`): the
// commits on head that base lacks (API v1 by full SHAs, cached) and the
// changes since they diverged — the diff from the oldest such commit's first
// parent (the merge base for a branch that forked from base) to head, as
// Forgejo's three-dot compare shows. Branch and tag names resolve from the
// pool; a side left out is the default branch, and without a head the page
// lists the branches to choose from. Between two branches of the repository
// it is also where a pull request is opened (NewPull.tsx): whether they
// merge, and the form (`?expand=1` opens it at once, as Forgejo's and
// GitHub's links do).

import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import {ChevronDown, GitBranch, GitCompare, GitPullRequest, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {reach} from '../../app/online.ts';
import {ForkCompare, type ForkBranch, forkBranches} from './ForkCompare.tsx';
import {useUpstream} from './upstream.ts';
import {type DiffFile, filePath} from '../../code/diff.ts';
import {resolveName} from '../../code/refs.ts';
import type {CodeSource, CommitInfo, CompareInfo} from '../../code/source.ts';
import type {Pool} from '../../data/pool.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Button, Callout, CommandPick, CommandPopover, EmptyState, Icon, type PickOption, SectionHeading, TextLink} from '../../ui/index.ts';
import {preloadEditor} from '../editor/Composer.tsx';
import {usePool} from '../issues/cells.tsx';
import {loadPeople} from '../issues/people.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {ChangedFiles, type DiffHandle, DiffView} from './DiffView.tsx';
import {DiffSettings} from './DiffSettings.tsx';
import {useDiff} from './History.tsx';
import {Ago, summary} from './bits.tsx';
import {linkedCommitRow} from './commitText.tsx';
import {type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {codeTo, useCodeRows} from './nav.tsx';
import {
  compareSplat, type BranchChoice, forkHead, headChoices, isForkHead, mergeOutlook, type MergeOutlook, proposable, pullDefaults, typedForkHead,
} from './proposal.ts';
import {NewPull, OutlookLine} from './NewPull.tsx';
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
export async function mergeBase(src: Pick<CodeSource, 'compare'>, repoId: number, base: string, info: CompareInfo): Promise<string> {
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

const compareKey = (repoId: number, base: string, head: string) => `compare:${String(repoId)}:${base}:${head}`;
const mergeBaseKey = (repoId: number, base: string, head: string) => `mergebase:${String(repoId)}:${base}:${head}`;

/** The merge base, remembered by its SHAs (the comparison is immutable). */
async function loadMergeBase(src: CodeSource, repoId: number, baseSha: string, headSha: string, info: CompareInfo): Promise<string> {
  const key = mergeBaseKey(repoId, baseSha, headSha);
  const hit = src.peek<string>(key);
  if (hit) return hit;
  const sha = await mergeBase(src, repoId, baseSha, info);
  src.cache.put(key, sha);
  return sha;
}

/** Fetches what a comparison's page shows (hover, the cursor on a branch to propose): it opens painted. */
function prefetchCompare(src: CodeSource, repoId: number, baseSha: string, headSha: string): void {
  void src.compare(repoId, baseSha, headSha).then(async (info) => {
    if (!info.commits.length) return;
    const from = await loadMergeBase(src, repoId, baseSha, headSha, info);
    await Promise.all([src.diff(repoId, from, headSha), src.compare(repoId, headSha, baseSha)]);
  }).catch(() => undefined);
}

/** The open pull request from head into base in this repository, if the pool has one. */
function openPullOf(pool: Pool, repoId: number, base: string, head: string) {
  return [...pool.model('PullRequest').all()].map((p) => p.data).find((p) => p.base_repo_id === repoId && p.head_repo_id === repoId &&
    p.base_branch === base && p.head_branch === head && pool.model('Issue').get(p.issue_id)?.get('state') === 'open');
}

/** Whether a pull request can be proposed between these names: two different branches of the repository. */
function branchPair(pool: Pool, repoId: number, base: string, head: string): boolean {
  const branches = refTable(pool, repoId).branches;
  return base !== head && branches.has(base) && branches.has(head);
}

/** `?expand=1` (and `true`, as GitHub writes it). */
function expanded(v: unknown): boolean {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

export const CompareView = observer(function CompareView(props: CodeViewProps & {base: string; head: string}) {
  const pool = usePool();
  const refs = refTable(pool, props.repoId);
  // `?expand=1` (Forgejo's and GitHub's "open a pull request" links): the form is open from the first frame.
  const expand = useSearch({strict: false, select: (s) => expanded((s as {expand?: unknown}).expand)});
  const [open, setOpen] = useState(expand);
  // Without a base in the address the head chooser keeps the one picked here (Forgejo's address has no place for it).
  const [picked, setPicked] = useState<string | undefined>();
  const baseName = props.base !== '' ? props.base : picked ?? refs.defaultBranch;
  const headName = props.head;
  const sides = {...props, base: baseName, head: headName, open};
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <ComparePick {...sides} side="base" value={baseName} onPick={headName ? undefined : setPicked}/>
      <span className="text-fg-subtle" aria-hidden>…</span>
      <ComparePick {...sides} side="head" value={headName}/>
    </span>
  );
  if (isForkHead(headName)) {
    return <CodeFrame view={props} title={title}>
      {(scroller) => <ForkCompare key={`${baseName}:${headName}`} {...sides} scroller={scroller}/>}
    </CodeFrame>;
  }
  if (!headName) {
    return (
      <CodeFrame view={props} title={title}>
        {(scroller) => <HeadChooser {...sides} scroller={scroller}/>}
      </CodeFrame>
    );
  }
  const base = resolveName(refs, baseName);
  const head = resolveName(refs, headName);
  // Either side switches to another branch or tag (the other side stays).
  return (
    <CodeFrame view={props} title={title} controls={<ComparePull {...sides} onOpen={() => {
      setOpen(true);
    }}/>}>
      {(scroller) => (base && head ?
        <Compared {...sides} baseSha={base} headSha={head} scroller={scroller} onClose={() => {
          setOpen(false);
        }}/> :
        <EmptyState icon={GitCompare} title="Branch or tag not found" description={`${base ? headName : baseName} does not exist, or is not on this device.`}/>)}
    </CodeFrame>
  );
});

type Sides = CodeViewProps & {base: string; head: string; open: boolean};

const ComparePick = observer(function ComparePick({owner, repo, repoId, base, head, open, side, value, onPick}: Sides & {side: 'base' | 'head'; value: string; onPick?: ((ref: string) => void) | undefined}) {
  const pool = usePool();
  const navigate = useNavigate();
  const app = useApp();
  const up = useUpstream(owner, repo, repoId);
  const [forks, setForks] = useState<ForkBranch[]>([]);
  const [forkState, setForkState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [query, setQuery] = useState('');
  const refs = refTable(pool, repoId);
  const branches = [...refs.branches.keys()].sort((a, b) => (a === refs.defaultBranch ? -1 : b === refs.defaultBranch ? 1 : a.localeCompare(b)));
  const tags = [...refs.tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  // The form stays open on the new comparison.
  const go = (to: ReturnType<typeof codeTo>) => {
    void navigate({...to, ...(open ? {search: {expand: '1'} as never} : {})});
  };
  const option = (ref: string, tag: boolean): PickOption => ({
    value: `${tag ? 'tag' : 'branch'}:${ref}`, label: ref, group: tag ? 'Tags' : `${owner}/${repo}`, icon: tag ? Tag : GitBranch,
    meta: !tag && ref === refs.defaultBranch ? 'default' : undefined, checked: ref === value,
    onSelect: () => {
      if (onPick) {
        onPick(ref);
        return;
      }
      go(codeTo(owner, repo, compareSplat(side === 'base' ? ref : base, side === 'head' ? ref : head)));
    },
  });
  const options = [...branches.map((b) => option(b, false)), ...tags.map((t) => option(t, true))];
  // A fork's base can be its upstream: the same head, proposed to the repository it was forked from.
  const upHead = side === 'base' && up ? head || refs.defaultBranch : '';
  if (up && upHead && refs.branches.has(upHead)) {
    options.push({
      value: `upstream:${up.owner}/${up.name}:${up.defaultBranch}`, label: up.defaultBranch, group: `${up.owner}/${up.name} (upstream)`, icon: GitBranch,
      words: `${up.owner}/${up.name}`, meta: 'default', checked: false, onSelect: () => {
        go(codeTo(up.owner, up.name, compareSplat(up.defaultBranch, forkHead(owner, repo, up.owner, upHead))));
      },
    });
  }
  if (side === 'head') {
    for (const f of forks) {
      options.push({...f, icon: GitBranch, checked: f.value === value, onSelect: () => {
        go(codeTo(owner, repo, compareSplat(base, f.value)));
      }});
    }
    // A fork's branch typed as `owner:branch` (or `owner/repo:branch`), listed or not.
    const typed = typedForkHead(query);
    if (typed && !forks.some((f) => f.value === typed)) {
      options.unshift({value: `typed:${typed}`, label: typed, group: 'A fork\u2019s branch', icon: GitBranch, onSelect: () => {
        go(codeTo(owner, repo, compareSplat(base, typed)));
      }});
    }
    if (forkState === 'loading') options.push({value: 'forks:loading', label: 'Loading the forks\u2019 branches\u2026', group: 'Forks', onSelect: () => undefined});
    if (forkState === 'error') options.push({value: 'forks:error', label: 'Could not load the forks\u2019 branches. Reopen to retry.', group: 'Forks', onSelect: () => undefined});
  }
  const label = side === 'base' ? 'Compare from' : 'Compare to';
  const placeholder = side === 'head' ? 'Find a branch or tag, or type owner:branch\u2026' : 'Find a branch or tag\u2026';
  return (
    <CommandPopover width="md" label={label} placeholder={placeholder}
      onOpenChange={(on) => {
        if (!on) setQuery('');
        if (!on || side !== 'head' || forkState === 'loading' || forkState === 'ready') return;
        setForkState('loading');
        void forkBranches(app, owner, repo).then((choices) => {
          setForks(choices);
          setForkState('ready');
        }, () => {
          setForkState('error');
        });
      }}
      options={options}
      render={(close) => (
        <CommandPick label={label} placeholder={placeholder} options={options} onClose={close} query={query} onQueryChange={setQuery}
          empty={side === 'head' ? 'No branch or tag of that name. A fork\u2019s branch: owner:branch.' : 'No branch or tag is on this device.'}/>
      )}
      trigger={
        <Button size="sm" icon={GitBranch} aria-label={value ? `${side === 'base' ? 'Base' : 'Head'}: ${value}` : 'Choose the head branch'}>
          <span className="max-w-xs truncate font-mono">{value || 'Choose a branch'}</span><Icon icon={ChevronDown} size="sm"/>
        </Button>
      }/>
  );
});

/**
 * The open pull request of these branches, or the button that opens the form (hover loads the editor and the
 * people the pickers offer, so the form paints complete). The button is offered once the comparison (the same one
 * the page lists, cached) has commits on head that base lacks: a head merged into base, or behind it, has a
 * different tip but nothing to propose, and the page says so instead.
 */
const ComparePull = observer(function ComparePull({owner, repo, repoId, base, head, open, onOpen}: Sides & {onOpen: () => void}) {
  const app = useApp();
  const pool = usePool();
  const src = useSource();
  const branches = refTable(pool, repoId).branches;
  const baseSha = branches.get(base);
  const headSha = branches.get(head);
  const pair = branchPair(pool, repoId, base, head) && baseSha !== undefined && headSha !== undefined && baseSha !== headSha;
  const key = pair && baseSha && headSha ? compareKey(repoId, baseSha, headSha) : undefined;
  const info = useLoad(key, () => (key ? src.peek<CompareInfo>(key) : undefined), () => src.compare(repoId, baseSha ?? '', headSha ?? ''));
  const pr = openPullOf(pool, repoId, base, head);
  if (pr) {
    return (
      <Button size="sm" variant="ghost" asChild>
        <Link to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}}><Icon icon={GitPullRequest} size="sm"/>Pull request #{pr.number}</Link>
      </Button>
    );
  }
  // Nothing to propose: not two branches, the same branch or commit, no commit that base lacks (or not known yet);
  // or the form is open already.
  if (open || !pair || info.state !== 'ready' || info.value.commits.length === 0) return null;
  return (
    <Button size="sm" variant="primary" icon={GitPullRequest} tooltip={`Propose merging ${head} into ${base}`} onPointerEnter={() => {
      void preloadEditor().catch(() => undefined);
      loadPeople(app, repoId);
    }} onClick={onOpen}>New pull request</Button>
  );
});

/**
 * In a fork, between two of its branches: a pull request opened here stays in the fork. Says so, and offers the
 * same head compared with the upstream's default branch (where a contribution is proposed).
 */
const UpstreamNotice = observer(function UpstreamNotice({owner, repo, repoId, head, open}: Sides) {
  const up = useUpstream(owner, repo, repoId);
  if (!up?.defaultBranch) return null;
  const upName = `${up.owner}/${up.name}`;
  return (
    <Callout title={`A pull request opened here stays in ${owner}/${repo}`}
      actions={
        <Button size="sm" variant="primary" asChild>
          <Link {...codeTo(up.owner, up.name, compareSplat(up.defaultBranch, forkHead(owner, repo, up.owner, head)))} {...(open ? {search: {expand: '1'} as never} : {})}>
            <Icon icon={GitPullRequest} size="sm"/>Compare with {upName}:{up.defaultBranch}
          </Link>
        </Button>
      }>
      {`This repository is a fork of ${upName}. To propose ${head} to ${upName}, compare it with ${upName}:${up.defaultBranch}.`}
    </Callout>
  );
});

const Compared = observer(function Compared(props: Sides & {baseSha: string; headSha: string; scroller: HTMLDivElement | null; onClose: () => void}) {
  const {owner, repo, repoId, baseSha, headSha, scroller} = props;
  const pool = usePool();
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const src = useSource();
  const key = compareKey(repoId, baseSha, headSha);
  const info = useLoad(key, () => src.peek<CompareInfo>(key), () => src.compare(repoId, baseSha, headSha));
  const mbKey = info.state === 'ready' ? mergeBaseKey(repoId, baseSha, headSha) : undefined;
  const mb = useLoad(mbKey, () => (mbKey ? src.peek<string>(mbKey) : undefined), async () => {
    if (info.state !== 'ready') throw new Error('no comparison');
    return loadMergeBase(src, repoId, baseSha, headSha, info.value);
  });
  const from = mb.state === 'ready' ? mb.value : undefined;
  const diff = useDiff(repoId, from ?? '', from ? headSha : '');
  const diffRef = useRef<DiffHandle>(null);
  // A pull request can be opened between two branches of the repository, unless one is open already.
  const pullable = branchPair(pool, repoId, props.base, props.head) && !openPullOf(pool, repoId, props.base, props.head);
  const outlook = useOutlook({repoId, baseSha, headSha, info, mb, diff, from, on: pullable});
  if (info.state !== 'ready') return <Unloaded loaded={info} what="This comparison"/>;
  if (!info.value.commits.length) {
    // Named as the user chose them (refs, not SHAs).
    const nothing = pullable ? ' There is nothing to open a pull request for.' : '';
    return <EmptyState icon={GitCompare} title="Nothing to compare" description={baseSha === headSha ?
      `${props.base} and ${props.head} are identical.${nothing}` : `${props.head} has no commits that ${props.base} lacks.${nothing}`}/>;
  }
  return (
    <>
      {pullable && (
        <div className="sticky left-0 flex w-view flex-col gap-3 border-b border-border px-4 py-3">
          <UpstreamNotice {...props}/>
          <OutlookLine outlook={outlook} base={props.base} head={props.head}/>
          {props.open && proposable(outlook) &&
            <NewPull owner={owner} repo={repo} repoId={repoId} base={props.base} head={props.head} outlook={outlook}
              defaults={pullDefaults(info.value.commits, info.value.total, props.head)} onCancel={props.onClose}/>}
        </div>
      )}
      <div className="sticky left-0 w-view border-b border-border">
        <div className="px-4 pt-3 pb-1"><SectionHeading>{`${String(info.value.total)} ${info.value.total === 1 ? 'commit' : 'commits'}`}</SectionHeading></div>
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={linkedCommitRow(owner, repo)}
          onOpen={rows.onOpen} linkOf={rows.linkOf}/>
      </div>
      <div className="sticky left-0 flex w-view justify-end px-4 py-1"><DiffSettings/></div>
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

const failed = (l: {state: string}) => l.state === 'error' || l.state === 'offline';

/** The paths a diff touches (a rename: both). */
function touched(files: readonly DiffFile[]): string[] {
  return [...new Set(files.flatMap((f) => (f.status === 'renamed' ? [f.oldPath, f.newPath] : [filePath(f)])))];
}

/**
 * Whether head merges into base, from what the device can load (`on`: only between branches a pull request can
 * be opened from): the commits base has that head lacks and, when base moved on, the files it changed since the
 * merge base — content-addressed and cached like the rest of the comparison.
 */
function useOutlook({repoId, baseSha, headSha, info, mb, diff, from, on}: {
  repoId: number; baseSha: string; headSha: string; info: Loaded<CompareInfo>; mb: Loaded<string>; diff: Loaded<DiffFile[]>; from: string | undefined; on: boolean;
}): MergeOutlook {
  const src = useSource();
  const ready = on && info.state === 'ready' && info.value.commits.length > 0;
  const behindKey = ready ? compareKey(repoId, headSha, baseSha) : undefined;
  const behind = useLoad(behindKey, () => (behindKey ? src.peek<CompareInfo>(behindKey) : undefined), () => src.compare(repoId, headSha, baseSha));
  const behindN = behind.state === 'ready' ? behind.value.total || behind.value.commits.length : undefined;
  const baseDiff = useDiff(repoId, from ?? '', from && behindN ? baseSha : '');
  if (failed(mb) || failed(diff) || failed(behind)) return {kind: 'unknown', behind: behindN ?? 0};
  return mergeOutlook({
    baseSha, headSha,
    ahead: info.state === 'ready' ? info.value.commits.length : undefined,
    behind: behindN,
    headFiles: diff.state === 'ready' ? touched(diff.value) : undefined,
    baseFiles: baseDiff.state === 'ready' ? touched(baseDiff.value) : failed(baseDiff) ? null : undefined,
  });
}

/**
 * No head yet (`compare`, the pull requests' "New pull request"): the branches to propose into the base, most
 * recently pushed first, each a link to its comparison with the form open. The cursor or the pointer on one loads
 * its comparison, so it opens painted.
 */
const HeadChooser = observer(function HeadChooser({owner, repo, repoId, base, scroller}: Sides & {scroller: HTMLDivElement | null}) {
  const pool = usePool();
  const session = useSession();
  const src = useSource();
  const navigate = useNavigate();
  const app = useApp();
  const refs = refTable(pool, repoId);
  const all = [...pool.model('Branch').by('repo_id', repoId)].map((b) => b.data).filter((b) => !b.is_deleted);
  const byName = new Map(all.map((b) => [b.name, b]));
  const choices = headChoices(all.map((b): BranchChoice => ({name: b.name, commitTime: b.commit_time, pusherId: b.pusher_id})), base, session.userId);
  const rows = useCodeRows<BranchChoice>(owner, repo, (b) => compareSplat(base, b.name));
  if (!refs.branches.has(base)) {
    return <EmptyState icon={GitCompare} title="Branch not found" description={`${base || 'The default branch'} does not exist, or is not on this device.`}/>;
  }
  const mine = <MyForkBranches owner={owner} repo={repo} base={base}/>;
  if (!choices.length) {
    return <>
      {mine}
      <EmptyState icon={GitBranch} title="No other branch" description={`Push a branch to propose merging its changes into ${base}, or choose a fork\u2019s branch above (owner:branch).`}/>
    </>;
  }
  return (
    <div className="sticky left-0 w-view">
      {mine}
      <div className="px-4 pt-3 pb-1"><SectionHeading>{`Choose a branch to merge into ${base}`}</SectionHeading></div>
      <RowList items={choices} scroller={scroller} label="Branches" keyOf={(b) => b.name}
        row={(b) => ({
          leading: <Icon icon={GitBranch} size="sm"/>,
          main: <><span className="font-mono">{b.name}</span> <span className="text-fg-subtle">{summary(byName.get(b.name)?.commit_message ?? '')}</span></>,
          trailing: b.commitTime ? <Ago at={b.commitTime}/> : undefined,
        })}
        onOpen={(b) => {
          void navigate({...codeTo(owner, repo, compareSplat(base, b.name)), search: {expand: '1'} as never});
        }}
        linkOf={(b) => `${rows.linkOf(b)}?expand=1`}
        onIntent={(b) => {
          const baseSha = refs.branches.get(base);
          const headSha = refs.branches.get(b.name);
          if (baseSha && headSha) prefetchCompare(src, repoId, baseSha, headSha);
          void preloadEditor().catch(() => undefined);
          loadPeople(app, repoId);
        }}/>
    </div>
  );
});

/**
 * The viewer's forks' branches, to propose into this repository (forks are not synced: API v1, online). Nothing
 * while loading, without a fork, or offline; the head picker lists every fork's branches and takes owner:branch.
 */
const MyForkBranches = observer(function MyForkBranches({owner, repo, base}: {owner: string; repo: string; base: string}) {
  const app = useApp();
  const session = useSession();
  const login = session.data.pool.model('User').get(session.userId)?.data.login;
  const online = reach(session.data.status.connection) === 'online';
  const key = login && online ? `${owner}/${repo}:${login}` : undefined;
  const [mine, setMine] = useState<{key: string; list: ForkBranch[]}>();
  useEffect(() => {
    if (!key || !login) return undefined;
    let live = true;
    forkBranches(app, owner, repo, login).then((list) => {
      if (live) setMine({key, list});
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [app, key, login, owner, repo]);
  const list = mine && mine.key === key ? mine.list : [];
  if (!list.length) return null;
  return (
    <section aria-label="Your forks" className="border-b border-border px-4 py-3">
      <SectionHeading>{`From your fork${new Set(list.map((b) => b.group)).size > 1 ? 's' : ''}`}</SectionHeading>
      <ul className="mt-1 flex flex-col gap-1">
        {list.map((b) => (
          <li key={b.value} className="flex items-center gap-2 text-base">
            <Icon icon={GitBranch} size="sm"/>
            <TextLink><Link {...codeTo(owner, repo, compareSplat(base, b.value))} search={{expand: '1'} as never}><span className="font-mono">{b.value}</span></Link></TextLink>
            <span className="text-sm text-fg-subtle">{b.group}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});
