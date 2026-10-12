// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Three-dot comparisons show changes since the merge base; refs resolve from the synced pool.

import {useNavigate, useSearch} from '@tanstack/react-router';
import {BranchName} from '@primer/react';
import {Banner} from '@primer/react';
import {Heading} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useEffect, useMemo, useRef, useState} from 'react';
import {reach} from '../../app/online.ts';
import {ForkCompare, type ForkBranch, forkBranches} from './ForkCompare.tsx';
import {useUpstream} from './upstream.ts';
import {type DiffFile, filePath} from '../../code/diff.ts';
import {resolveName} from '../../code/refs.ts';
import type {CodeSource, CommitInfo, CompareInfo} from '../../code/source.ts';
import type {Pool} from '../../data/pool.ts';
import {useApp, useSession} from '../../app/store.ts';

import {ChoicePanel, type CodeChoice} from './ChoicePanel.tsx';
import {preloadEditor} from '../editor/Composer.tsx';
import {usePool} from '../issues/cells.tsx';
import {loadPeople} from '../issues/people.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {ChangedFiles, type DiffHandle, DiffView} from './DiffView.tsx';
import {DiffSettings} from './DiffSettings.tsx';
import {useDiff} from './History.tsx';
import {Ago, summary} from './bits.tsx';
import {linkedCommitRow} from './commitText.tsx';
import {withChecks} from './commitChecks.tsx';
import {type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {codeTo, useCodeRows} from './nav.tsx';
import {
  compareSplat, type BranchChoice, forkHead, headChoices, isForkHead, mergeOutlook, type MergeOutlook, proposable, pullDefaults, typedForkHead,
} from './proposal.ts';
import {NewPull, OutlookLine} from './NewPull.tsx';
import {RowList} from './RowList.tsx';
import {Unloaded} from './states.tsx';
import {ChevronDownIcon, GitBranchIcon, GitCompareIcon, GitPullRequestIcon, TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Tooltip} from '@primer/react';
import {RouterLinkButton, RouterLink} from '../../app/routerLinks.tsx';
import {Blankslate} from '@primer/react/experimental';

/** Merge-base candidates are parents of new commits that base and head already share. */
export function baseCandidates(info: CompareInfo, base: string): string[] {
  const listed = new Set(info.commits.map((c) => c.sha));
  const out: string[] = [];
  for (const c of info.commits) for (const p of c.parents) if (!listed.has(p) && !out.includes(p)) out.push(p);
  return out.length ? out : [base];
}

/** API v1 omits the merge base; choose the candidate descended from every other candidate. */
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

async function loadMergeBase(src: CodeSource, repoId: number, baseSha: string, headSha: string, info: CompareInfo): Promise<string> {
  const key = mergeBaseKey(repoId, baseSha, headSha);
  const hit = src.peek<string>(key);
  if (hit) return hit;
  const sha = await mergeBase(src, repoId, baseSha, info);
  src.cache.put(key, sha);
  return sha;
}

function prefetchCompare(src: CodeSource, repoId: number, baseSha: string, headSha: string): void {
  void src.compare(repoId, baseSha, headSha).then(async (info) => {
    if (!info.commits.length) return;
    const from = await loadMergeBase(src, repoId, baseSha, headSha, info);
    await Promise.all([src.diff(repoId, from, headSha), src.compare(repoId, headSha, baseSha)]);
  }).catch(() => undefined);
}

function openPullOf(pool: Pool, repoId: number, base: string, head: string) {
  return [...pool.model('PullRequest').by('head_repo_id', repoId)].map((p) => p.data).find((p) => p.base_repo_id === repoId &&
    p.base_branch === base && p.head_branch === head && pool.model('Issue').get(p.issue_id)?.get('state') === 'open');
}

function branchPair(pool: Pool, repoId: number, base: string, head: string): boolean {
  const branches = refTable(pool, repoId).branches;
  return base !== head && branches.has(base) && branches.has(head);
}

/** Accept Forgejo and GitHub expand query values. */
function expanded(v: unknown): boolean {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

export const CompareView = observer(function CompareView(props: CodeViewProps & {base: string; head: string}) {
  const pool = usePool();
  const refs = refTable(pool, props.repoId);
  const expand = useSearch({strict: false, select: (s) => expanded((s as {expand?: unknown}).expand)});
  const [open, setOpen] = useState(expand);
  // A headless compare URL cannot encode the selected base.
  const [picked, setPicked] = useState<string | undefined>();
  const baseName = props.base !== '' ? props.base : picked ?? refs.defaultBranch;
  const headName = props.head;
  const sides = {...props, base: baseName, head: headName, open};
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <ComparePick {...sides} side="base" value={baseName} onPick={headName ? undefined : setPicked}/>
      <span className="text-muted" aria-hidden>…</span>
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
  return (
    <CodeFrame view={props} title={title} controls={<ComparePull {...sides} onOpen={() => {
      setOpen(true);
    }}/>}>
      {(scroller) => (base && head ?
        <Compared {...sides} baseSha={base} headSha={head} scroller={scroller} onClose={() => {
          setOpen(false);
        }}/> :
        <Blankslate><Blankslate.Visual><GitCompareIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Branch or tag not found</Blankslate.Heading><Blankslate.Description>{`${base ? headName : baseName} does not exist, or is not on this device.`}</Blankslate.Description></Blankslate>)}
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
  const go = (to: ReturnType<typeof codeTo>) => {
    void navigate({...to, ...(open ? {search: {expand: '1'} as never} : {})});
  };
  const option = (ref: string, tag: boolean): CodeChoice => ({
    value: `${tag ? 'tag' : 'branch'}:${ref}`, label: ref, group: tag ? 'Tags' : `${owner}/${repo}`, icon: tag ? TagIcon : GitBranchIcon,
    meta: !tag && ref === refs.defaultBranch ? 'default' : undefined, checked: ref === value,
    onSelect: () => {
      if (onPick) {
        onPick(ref);
        return;
      }
      go(codeTo(owner, repo, compareSplat(side === 'base' ? ref : base, side === 'head' ? ref : head)));
    },
  });
  const options = [...refs.branchNames.map((b) => option(b, false)), ...refs.tagNames.map((t) => option(t, true))];
  const upHead = side === 'base' && up ? head || refs.defaultBranch : '';
  if (up && upHead && refs.branches.has(upHead)) {
    options.push({
      value: `upstream:${up.owner}/${up.name}:${up.defaultBranch}`, label: up.defaultBranch, group: `${up.owner}/${up.name} (upstream)`, icon: GitBranchIcon,
      words: `${up.owner}/${up.name}`, meta: 'default', checked: false, onSelect: () => {
        go(codeTo(up.owner, up.name, compareSplat(up.defaultBranch, forkHead(owner, repo, up.owner, upHead))));
      },
    });
  }
  if (side === 'head') {
    for (const f of forks) {
      options.push({...f, icon: GitBranchIcon, checked: f.value === value, onSelect: () => {
        go(codeTo(owner, repo, compareSplat(base, f.value)));
      }});
    }
    const typed = typedForkHead(query);
    if (typed && !forks.some((f) => f.value === typed)) {
      options.unshift({value: `typed:${typed}`, label: typed, group: 'A fork\u2019s branch', icon: GitBranchIcon, onSelect: () => {
        go(codeTo(owner, repo, compareSplat(base, typed)));
      }});
    }
    if (forkState === 'loading') options.push({value: 'forks:loading', label: 'Loading the forks\u2019 branches\u2026', group: 'Forks', onSelect: () => undefined});
    if (forkState === 'error') options.push({value: 'forks:error', label: 'Could not load the forks\u2019 branches. Reopen to retry.', group: 'Forks', onSelect: () => undefined});
  }
  const label = side === 'base' ? 'Compare from' : 'Compare to';
  const placeholder = side === 'head' ? 'Find a branch or tag, or type owner:branch\u2026' : 'Find a branch or tag\u2026';
  return (
    <ChoicePanel title={label} placeholder={placeholder} query={query} onQueryChange={setQuery}
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
      choices={options}
      anchor={
        <Button size="small" leadingVisual={GitBranchIcon} trailingVisual={ChevronDownIcon} type="button" aria-label={value ? `${side === 'base' ? 'Base' : 'Head'}: ${value}` : 'Choose the head branch'}>
          <BranchName as="span" className="max-w-xs truncate">{value || 'Choose a branch'}</BranchName>
        </Button>
      }/>
  );
});

/** A distinct tip is not enough: only commits absent from base can be proposed. */
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
      <RouterLinkButton variant="invisible" size="small" leadingVisual={GitPullRequestIcon} to="/$owner/$repo/pulls/$index" params={{owner, repo, index: String(pr.number)}}>Pull request #{pr.number}</RouterLinkButton>
    );
  }
  if (open || !pair || info.state !== 'ready' || info.value.commits.length === 0) return null;
  return (
    <Tooltip text={`Propose merging ${head} into ${base}`}><Button variant="primary" size="small" leadingVisual={GitPullRequestIcon} type="button" onPointerEnter={() => {
      void preloadEditor().catch(() => undefined);
      loadPeople(app, repoId);
    }} onClick={onOpen}>New pull request</Button></Tooltip>
  );
});

const UpstreamNotice = observer(function UpstreamNotice({owner, repo, repoId, head, open}: Sides) {
  const up = useUpstream(owner, repo, repoId);
  if (!up?.defaultBranch) return null;
  const upName = `${up.owner}/${up.name}`;
  return (
    <Banner title={`A pull request opened here stays in ${owner}/${repo}`}
      primaryAction={
        <RouterLinkButton variant="primary" size="small" leadingVisual={GitPullRequestIcon} {...codeTo(up.owner, up.name, compareSplat(up.defaultBranch, forkHead(owner, repo, up.owner, head)))} {...(open ? {search: {expand: '1'} as never} : {})}>Compare with {upName}:{up.defaultBranch}</RouterLinkButton>
      } description={<>
      {`This repository is a fork of ${upName}. To propose ${head} to ${upName}, compare it with ${upName}:${up.defaultBranch}.`}
    </>}/>
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
  const pullable = branchPair(pool, repoId, props.base, props.head) && !openPullOf(pool, repoId, props.base, props.head);
  const outlook = useOutlook({repoId, baseSha, headSha, info, mb, diff, from, on: pullable});
  const repos = useMemo(() => ({base_repo_id: repoId, head_repo_id: repoId}), [repoId]);
  if (info.state !== 'ready') return <Unloaded loaded={info} what="This comparison"/>;
  if (!info.value.commits.length) {
    const nothing = pullable ? ' There is nothing to open a pull request for.' : '';
    return <Blankslate><Blankslate.Visual><GitCompareIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Nothing to compare</Blankslate.Heading><Blankslate.Description>{baseSha === headSha ?
      `${props.base} and ${props.head} are identical.${nothing}` : `${props.head} has no commits that ${props.base} lacks.${nothing}`}</Blankslate.Description></Blankslate>;
  }
  return (
    <>
      {pullable && (
        <div className="sticky left-0 flex w-view flex-col gap-3 border-b border-default px-4 py-3">
          <UpstreamNotice {...props}/>
          <OutlookLine outlook={outlook} base={props.base} head={props.head}/>
          {props.open && proposable(outlook) &&
            <NewPull owner={owner} repo={repo} repoId={repoId} base={props.base} head={props.head} outlook={outlook}
              defaults={pullDefaults(info.value.commits, info.value.total, props.head)} onCancel={props.onClose}/>}
        </div>
      )}
      <div className="sticky left-0 w-view border-b border-default">
        <div className="px-4 pt-3 pb-1"><Heading as="h2" variant="small">{`${String(info.value.total)} ${info.value.total === 1 ? 'commit' : 'commits'}`}</Heading></div>
        <RowList items={info.value.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
          row={withChecks(linkedCommitRow(owner, repo), owner, repo, repos)}
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

function touched(files: readonly DiffFile[]): string[] {
  return [...new Set(files.flatMap((f) => (f.status === 'renamed' ? [f.oldPath, f.newPath] : [filePath(f)])))];
}

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
    return <Blankslate><Blankslate.Visual><GitCompareIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Branch not found</Blankslate.Heading><Blankslate.Description>{`${base || 'The default branch'} does not exist, or is not on this device.`}</Blankslate.Description></Blankslate>;
  }
  const mine = <MyForkBranches owner={owner} repo={repo} base={base}/>;
  if (!choices.length) {
    return <>
      {mine}
      <Blankslate><Blankslate.Visual><GitBranchIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No other branch</Blankslate.Heading><Blankslate.Description>{`Push a branch to propose merging its changes into ${base}, or choose a fork\u2019s branch above (owner:branch).`}</Blankslate.Description></Blankslate>
    </>;
  }
  return (
    <div className="sticky left-0 w-view">
      {mine}
      <div className="px-4 pt-3 pb-1"><Heading as="h2" variant="small">{`Choose a branch to merge into ${base}`}</Heading></div>
      <RowList items={choices} scroller={scroller} label="Branches" keyOf={(b) => b.name}
        row={(b) => ({
          leading: <GitBranchIcon size={12} className="shrink-0"/>,
          main: <><BranchName as="span">{b.name}</BranchName> <span className="text-muted">{summary(byName.get(b.name)?.commit_message ?? '')}</span></>,
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

/** Forks are not synced; load their branches through API v1 while online. */
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
    <section aria-label="Your forks" className="border-b border-default px-4 py-3">
      <Heading as="h2" variant="small">{`From your fork${new Set(list.map((b) => b.group)).size > 1 ? 's' : ''}`}</Heading>
      <ul className="mt-1 flex flex-col gap-1">
        {list.map((b) => (
          <li key={b.value} className="flex items-center gap-2 text-base">
            <GitBranchIcon size={12} className="shrink-0"/>
            <RouterLink {...codeTo(owner, repo, compareSplat(base, b.value))} search={{expand: '1'} as never} muted className="min-w-0 truncate"><span className="font-mono">{b.value}</span></RouterLink>
            <span className="text-sm text-muted">{b.group}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});
