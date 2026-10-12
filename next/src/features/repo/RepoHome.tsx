// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {DataRow, ResourceRows} from './layout.tsx';
import {Label, Tooltip} from '@primer/react';

import {useNavigate} from '@tanstack/react-router';
import {discoverySearch} from '../search/params.ts';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo} from 'react';
import {whenIdle} from '../../app/lazy.tsx';
import {openCreate} from '../../app/create.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {codePath} from '../../app/paths.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {APITree, APITreeEntry} from '../../protocol/types.gen.ts';
import {codeSplat} from '../../code/refs.ts';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {GoToFile} from '../code/FileFinder.tsx';
import {codeTo} from '../code/nav.tsx';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {RefMenu} from '../code/RefMenu.tsx';
import {ReadmePanel, readmeOf} from '../code/Rendered.tsx';
import {Unloaded} from '../code/states.tsx';
import {entryParts, FilesPanel, RefCommit, treeOrder} from '../code/tree.tsx';
import {usePool} from '../issues/cells.tsx';
import {AboutSidebar} from './AboutSidebar.tsx';
import {plural} from './about.ts';
import {CodeMenu} from './CodeMenu.tsx';
import {Contribute} from './Contribute.tsx';
import {RepoActions, RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {EmptyRepo} from '../code/states.tsx';
import {FileOperations} from '../code/FileOperations.tsx';
import {CodeIcon, FileDirectoryFillIcon, FileSubmoduleIcon, GitBranchIcon, HistoryIcon, PencilIcon, TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Blankslate, SkeletonText} from '@primer/react/experimental';

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
  const app = useApp();
  const repository = usePool().model('Repository').get(repoId)?.data;
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={CodeIcon} title="Code" home/>
      <PageBody>
        <div className="flex flex-col @xl:min-h-full @xl:flex-row">
          <PageColumn wide>
            <div className="flex flex-wrap items-center gap-2">
              <Summary repoId={repoId}/>
              <div className="ms-auto flex flex-wrap items-center gap-2">
                <RepoActions owner={owner} repo={repo} repoId={repoId}/>
                <Tooltip text={'New issue in this repository'} keybindingHint={shortcutHint('create')}><Button variant="invisible" size="small" leadingVisual={PencilIcon} type="button" onClick={() => {
                  openCreate(app, repoId);
                }}>New issue</Button></Tooltip>
              </div>
            </div>
            {repository?.fork && <Contribute owner={owner} repo={repo}/>}
            <Files owner={owner} repo={repo} repoId={repoId}/>
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
  const r = usePool().model('Repository').get(repoId)?.data;
  if (!r) return null;
  const flags = [r.private ? 'Private' : 'Public', r.fork && 'Fork', r.mirror && 'Mirror', r.template && 'Template', r.archived && 'Archived'].filter((f): f is string => Boolean(f));
  return (
    <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-default">
      {r.name}
      {flags.map((f) => <Label key={f} variant={f === 'Archived' ? 'attention' : 'default'}>{f}</Label>)}
    </h2>
  );
});

/** Bound the overview list; the code view exposes the full tree. */
const MAX_ENTRIES = 60;

const Files = observer(function Files({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const navigate = useNavigate();
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
  const toolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <RefMenu owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha, path: ''}} view="src"/>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={GitBranchIcon} {...codeTo(owner, repo, 'branches')}><span className="tabular-nums">{`${String(branches)} ${plural(branches, 'branch', 'branches')}`}</span></RouterLinkButton>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={TagIcon} {...codeTo(owner, repo, 'tags')}><span className="tabular-nums">{`${String(tags)} ${plural(tags, 'tag')}`}</span></RouterLinkButton>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <Button size="small" type="button" onClick={() => { void navigate({to: '/search', search: discoverySearch({type: 'code', repoId})}); }}>Search code</Button>
        <GoToFile owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha}}/>
        <CodeMenu owner={owner} repo={repo} branch={branch}/>
      </div>
    </div>
  );
  // API v1 exposes no commit count here, so the link uses "History".
  const title = <RefCommit owner={owner} repo={repo} repoId={repoId} kind="branch" name={branch} sha={sha} showRef={false}/>;
  const history = (
    <RouterLinkButton variant="invisible" size="small" leadingVisual={HistoryIcon} {...codeTo(owner, repo, codeSplat('commits', {kind: 'branch', ref: branch}))}>History</RouterLinkButton>
  );
  return <Tree owner={owner} repo={repo} repoId={repoId} sha={sha} branch={branch} title={title} toolbar={toolbar} actions={history}/>;
});

const Tree = observer(function Tree({owner, repo, repoId, sha, branch, title, toolbar, actions}: {
  owner: string; repo: string; repoId: number; sha: string; branch: string; title: ReactNode; toolbar: ReactNode; actions: ReactNode;
}) {
  const app = useApp();
  const src = useSource();
  const click = useLinkClick();
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
  const entries = useMemo(() => (tree.state === 'ready' ?
    treeOrder(tree.value.entries) :
    []), [tree]);
  const readme = readmeOf(entries);
  const all = hrefOf(app, codePath(owner, repo, `src/branch/${branch}`));
  return (
    <>
      {toolbar}
      <FileOperations owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha, path: ''}}>
      <ResourceRows><FilesPanel title={title} actions={actions}>
        {tree.state === 'ready' ?
          entries.slice(0, MAX_ENTRIES).map((e) => <EntryRow key={e.name} owner={owner} repo={repo} branch={branch} entry={e}/>) :
          <Unloaded loaded={tree} what="This repository's files" skeleton={<div className="px-4 py-3"><SkeletonText lines={5}/></div>}/>}
        {entries.length > MAX_ENTRIES && (
          <DataRow compact href={all} onClick={(e) => click(e, all)} leading={<FileDirectoryFillIcon size={16} className="shrink-0"/>}>
            {entries.length - MAX_ENTRIES} more
          </DataRow>
        )}
      </FilesPanel></ResourceRows>
      </FileOperations>
      {readme && <ReadmePanel repoId={repoId} entry={readme} dir="" at={{kind: 'branch', ref: branch, sha}}/>}
    </>
  );
});

function EntryRow({owner, repo, branch, entry}: {owner: string; repo: string; branch: string; entry: APITreeEntry}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, codePath(owner, repo, `src/branch/${branch}/${entry.name}`));
  const parts = entryParts(entry);
  return (
    <DataRow compact href={href} onClick={(e) => click(e, href)} leading={parts.leading} trailing={parts.trailing}>
      {parts.main}
    </DataRow>
  );
}

