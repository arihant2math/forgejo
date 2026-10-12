// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {Label} from '@primer/react';
import {Blankslate, SkeletonText} from '@primer/react/experimental';
import {CodeIcon, FileSubmoduleIcon, GitBranchIcon, HistoryIcon, TagIcon} from '@primer/octicons-react';
import {whenIdle} from '../../app/lazy.tsx';
import {RouterLink, RouterLinkButton} from '../../app/routerLinks.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {codeSplat, type Resolved} from '../../code/refs.ts';
import {CodeSource} from '../../code/source.ts';
import type {APITree} from '../../protocol/types.gen.ts';
import {GoToFile} from '../code/FileFinder.tsx';
import {FileOperations} from '../code/FileOperations.tsx';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {codeTo} from '../code/nav.tsx';
import {RefMenu} from '../code/RefMenu.tsx';
import {ReadmePanel, readmeOf} from '../code/Rendered.tsx';
import {EmptyRepo, Unloaded} from '../code/states.tsx';
import {DirEntries, FilesPanel, RefCommit} from '../code/tree.tsx';
import {usePool} from '../issues/cells.tsx';
import {AboutSidebar} from './AboutSidebar.tsx';
import {plural} from './about.ts';
import {CodeMenu} from './CodeMenu.tsx';
import {Contribute} from './Contribute.tsx';
import {RepoActions, RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';

export function RepoHome() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={CodeIcon} title="Code" home/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <RepoHomePage key={repoId} owner={owner} repo={repo} repoId={repoId}/>;
}

const RepoHomePage = observer(function RepoHomePage({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const fork = usePool().model('Repository').get(repoId)?.get('fork') ?? false;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={CodeIcon} title="Code" home/>
      <PageBody ref={setScroller}>
        <div className="flex flex-col @xl:min-h-full @xl:flex-row">
          <PageColumn wide>
            <div className="flex flex-wrap items-center gap-2">
              <Summary repoId={repoId}/>
              <div className="ms-auto">
                <RepoActions owner={owner} repo={repo} repoId={repoId}/>
              </div>
            </div>
            {fork && <Contribute owner={owner} repo={repo} repoId={repoId}/>}
            <Files owner={owner} repo={repo} repoId={repoId} scroller={scroller}/>
          </PageColumn>
          <aside aria-label="About" className="shrink-0 border-t border-default p-4 @xl:w-pane @xl:border-t-0 @xl:border-l">
            <AboutSidebar owner={owner} repo={repo} repoId={repoId}/>
          </aside>
        </div>
      </PageBody>
    </>
  );
});

const Summary = observer(function Summary({repoId}: {repoId: number}) {
  const pool = usePool();
  const r = pool.model('Repository').get(repoId)?.data;
  if (!r) return null;
  const parent = r.fork && r.parent_id > 0 ? pool.model('Repository').get(r.parent_id)?.data : undefined;
  const flags = [r.private ? 'Private' : 'Public', r.fork && !parent && 'Fork', r.mirror && 'Mirror', r.template && 'Template', r.archived && 'Archived'].filter((f): f is string => Boolean(f));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-default">
        {r.name}
        {flags.map((f) => <Label key={f} variant={f === 'Archived' ? 'attention' : 'default'}>{f}</Label>)}
      </h2>
      {parent && (
        <p className="min-w-0 truncate text-sm text-muted">
          forked from <RouterLink to="/$owner/$repo" params={{owner: parent.owner_name, repo: parent.name}} activeOptions={{exact: true}} muted>{parent.full_name}</RouterLink>
        </p>
      )}
    </div>
  );
});

const Files = observer(function Files({owner, repo, repoId, scroller}: {owner: string; repo: string; repoId: number; scroller: HTMLElement | null}) {
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const branch = refs.defaultBranch;
  const sha = refs.branches.get(branch);
  const r = pool.model('Repository').get(repoId)?.data;
  if (!sha) {
    return (
      <FilesPanel title={<><GitBranchIcon size={12} className="shrink-0"/>Code</>}>
        {r?.empty ? <EmptyRepo owner={owner} repo={repo} repoId={repoId}/> :
          <Blankslate><Blankslate.Visual><FileSubmoduleIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No code on this device yet</Blankslate.Heading><Blankslate.Description>Its branches have not arrived yet.</Blankslate.Description></Blankslate>}
      </FilesPanel>
    );
  }
  const branches = refs.branches.size;
  const tags = refs.tags.size;
  const at = {kind: 'branch', ref: branch, sha, path: ''} as const;
  // GitHub's bar: ref picker, branch and tag counts, then Go to file, Add file and Code.
  const toolbar = (addFile: ReactNode) => (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <RefMenu owner={owner} repo={repo} repoId={repoId} at={at} view="src"/>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={GitBranchIcon} {...codeTo(owner, repo, 'branches')}><span className="tabular-nums">{`${String(branches)} ${plural(branches, 'branch', 'branches')}`}</span></RouterLinkButton>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={TagIcon} {...codeTo(owner, repo, 'tags')}><span className="tabular-nums">{`${String(tags)} ${plural(tags, 'tag')}`}</span></RouterLinkButton>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <GoToFile owner={owner} repo={repo} repoId={repoId} at={at}/>
        {addFile}
        <CodeMenu owner={owner} repo={repo} branch={branch}/>
      </div>
    </div>
  );
  // API v1 exposes no commit count here, so the link uses "History".
  const title = <RefCommit owner={owner} repo={repo} repoId={repoId} kind="branch" name={branch} sha={sha} showRef={false}/>;
  const history = (
    <RouterLinkButton variant="invisible" size="small" leadingVisual={HistoryIcon} {...codeTo(owner, repo, codeSplat('commits', at))}>History</RouterLinkButton>
  );
  return <Tree owner={owner} repo={repo} repoId={repoId} at={at} title={title} toolbar={toolbar} actions={history} scroller={scroller}/>;
});

const Tree = observer(function Tree({owner, repo, repoId, at, title, toolbar, actions, scroller}: {
  owner: string; repo: string; repoId: number; at: Resolved; title: ReactNode; toolbar: (addFile: ReactNode) => ReactNode; actions: ReactNode; scroller: HTMLElement | null;
}) {
  const src = useSource();
  const {sha, ref: branch} = at;
  const key = CodeSource.treeKey(repoId, sha, '');
  // Fetch the common README.md alongside the tree to avoid a serial round trip; warm its highlighter too.
  useEffect(() => {
    void src.renderedAt(repoId, sha, 'README.md', {kind: 'branch', name: branch}).catch(() => undefined);
    // Idle callbacks can outlive the page or test environment.
    let live = true;
    whenIdle(() => {
      if (live) src.preheat();
    });
    return () => {
      live = false;
    };
  }, [src, repoId, sha, branch]);
  const tree = useLoad(key, () => src.peek<APITree>(key), () => src.tree(repoId, sha, ''));
  const readme = tree.state === 'ready' ? readmeOf(tree.value.entries) : undefined;
  return (
    <FileOperations owner={owner} repo={repo} repoId={repoId} at={at}>
      {(addFile, dropProps) => <>
        {toolbar(addFile)}
        <div {...dropProps}>
          <FilesPanel title={title} actions={actions}>
            {tree.state === 'ready' ?
              <DirEntries owner={owner} repo={repo} repoId={repoId} at={at} tree={tree.value} scroller={scroller}/> :
              <Unloaded loaded={tree} what="This repository's files" skeleton={<div className="px-4 py-3"><SkeletonText lines={5}/></div>}/>}
          </FilesPanel>
        </div>
        {readme && <ReadmePanel repoId={repoId} entry={readme} dir="" at={at}/>}
      </>}
    </FileOperations>
  );
});
