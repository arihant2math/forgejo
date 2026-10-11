// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's home (/{owner}/{repo}), the Code tab's first page: its
// name and kind; above its files, like GitHub's, the branch picker (to that
// branch's tree), the numbers of branches and tags (their pages), Go to file
// (FileFinder.tsx, key T) and the Code menu (clone URLs, archives:
// CodeMenu.tsx), all from the pool at once; the latest commit with its History; its top-level files and its README from the code
// cache (by commit and blob SHA: there offline once seen); and beside them
// the side pane (AboutSidebar.tsx: what it is, its releases and languages).
// The tabs lead to everything else. Its own chunk.

import {Code2, Folder, FolderGit2, GitBranch, History, SquarePen, Tag} from 'lucide-react';
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
import {Badge, Button, EmptyState, Icon, ListRow, SkeletonText} from '../../ui/index.ts';
import {codeSplat} from '../../code/refs.ts';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {GoToFile} from '../code/FileFinder.tsx';
import {CodeLink} from '../code/nav.tsx';
import {RefMenu} from '../code/RefMenu.tsx';
import {ReadmePanel, readmeOf} from '../code/Rendered.tsx';
import {Unloaded} from '../code/states.tsx';
import {entryParts, FilesPanel, RefCommit, treeOrder} from '../code/tree.tsx';
import {usePool} from '../issues/cells.tsx';
import {AboutSidebar} from './AboutSidebar.tsx';
import {plural} from './about.ts';
import {CodeMenu} from './CodeMenu.tsx';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {EmptyRepo} from '../code/states.tsx';

export function RepoHome() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={Code2} title="Code" home/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <RepoHomePage key={repoId} owner={owner} repo={repo} repoId={repoId}/>;
}

const RepoHomePage = observer(function RepoHomePage({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={Code2} title="Code" home>
        <Button size="sm" variant="ghost" icon={SquarePen} shortcut={shortcutHint('create')} tooltip="New issue in this repository" onClick={() => {
          openCreate(app, repoId);
        }}>New issue</Button>
      </RepoHeader>
      <PageBody>
        <div className="flex flex-col @xl:min-h-full @xl:flex-row">
          <PageColumn wide>
            <Summary repoId={repoId}/>
            <Files owner={owner} repo={repo} repoId={repoId}/>
          </PageColumn>
          <aside aria-label="About" className="shrink-0 border-t border-border p-4 @xl:w-pane @xl:border-t-0 @xl:border-l">
            <AboutSidebar owner={owner} repo={repo} repoId={repoId}/>
          </aside>
        </div>
      </PageBody>
    </>
  );
});

/** The repository's name and kind (its description and topics are in the side pane's About, like GitHub's). */
const Summary = observer(function Summary({repoId}: {repoId: number}) {
  const r = usePool().model('Repository').get(repoId)?.data;
  if (!r) return null;
  const flags = [r.private ? 'Private' : 'Public', r.fork && 'Fork', r.mirror && 'Mirror', r.template && 'Template', r.archived && 'Archived'].filter((f): f is string => Boolean(f));
  return (
    <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-fg">
      {r.name}
      {flags.map((f) => <Badge key={f} tone={f === 'Archived' ? 'warning' : 'neutral'} round>{f}</Badge>)}
    </h2>
  );
});

/** At most this many top-level entries are listed (the branch's tree in the code view has them all). */
const MAX_ENTRIES = 60;

/** The default branch's latest commit, its top-level files and its README. */
const Files = observer(function Files({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const pool = usePool();
  const refs = refTable(pool, repoId);
  const branch = refs.defaultBranch;
  const sha = refs.branches.get(branch);
  const r = pool.model('Repository').get(repoId)?.data;
  if (!sha) {
    return (
      <FilesPanel title={<><Icon icon={GitBranch} size="sm"/>Code</>}>
        {r?.empty ? <EmptyRepo owner={owner} repo={repo} repoId={repoId}/> :
          <EmptyState icon={FolderGit2} title="No code on this device yet" description="Its branches have not arrived yet."/>}
      </FilesPanel>
    );
  }
  // GitHub's bar above the files: on the left the branch picker and how many branches and tags there are (their
  // pages); on the right Go to file and the Code menu. From the pool and the configuration: there at once, the same
  // size before and after the tree arrives; it wraps on a narrow page.
  const branches = refs.branches.size;
  const tags = refs.tags.size;
  const toolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <RefMenu owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha, path: ''}} view="src"/>
      <Button size="sm" variant="ghost" asChild>
        <CodeLink owner={owner} repo={repo} to="branches">
          <Icon icon={GitBranch} size="sm"/><span className="tabular-nums">{`${String(branches)} ${plural(branches, 'branch', 'branches')}`}</span>
        </CodeLink>
      </Button>
      <Button size="sm" variant="ghost" asChild>
        <CodeLink owner={owner} repo={repo} to="tags">
          <Icon icon={Tag} size="sm"/><span className="tabular-nums">{`${String(tags)} ${plural(tags, 'tag')}`}</span>
        </CodeLink>
      </Button>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <GoToFile owner={owner} repo={repo} repoId={repoId} at={{kind: 'branch', ref: branch, sha}}/>
        <CodeMenu owner={owner} repo={repo} branch={branch}/>
      </div>
    </div>
  );
  // The latest commit's bar, with the history on the right (API v1 has no commit count the pool holds: "History").
  const title = <RefCommit owner={owner} repo={repo} repoId={repoId} kind="branch" name={branch} sha={sha} showRef={false}/>;
  const history = (
    <Button size="sm" variant="ghost" asChild>
      <CodeLink owner={owner} repo={repo} to={codeSplat('commits', {kind: 'branch', ref: branch})}><Icon icon={History} size="sm"/>History</CodeLink>
    </Button>
  );
  return <Tree owner={owner} repo={repo} repoId={repoId} sha={sha} branch={branch} title={title} toolbar={toolbar} actions={history}/>;
});

function Tree({owner, repo, repoId, sha, branch, title, toolbar, actions}: {
  owner: string; repo: string; repoId: number; sha: string; branch: string; title: ReactNode; toolbar: ReactNode; actions: ReactNode;
}) {
  const app = useApp();
  const src = useSource();
  const click = useLinkClick();
  const key = CodeSource.treeKey(repoId, sha, '');
  // The README is asked for with the tree, not after it (README.md, by far the most common name: the server reads
  // and renders it in one round trip; another name is asked once the tree names it), and the highlighter starts
  // meanwhile for its code blocks.
  useEffect(() => {
    void src.renderedAt(repoId, sha, 'README.md', {kind: 'branch', name: branch}).catch(() => undefined);
    whenIdle(() => {
      src.preheat();
    });
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
      <FilesPanel title={title} actions={actions}>
        {tree.state === 'ready' ?
          entries.slice(0, MAX_ENTRIES).map((e) => <EntryRow key={e.name} owner={owner} repo={repo} branch={branch} entry={e}/>) :
          <Unloaded loaded={tree} what="This repository's files" skeleton={<div className="px-3 py-3"><SkeletonText lines={5}/></div>}/>}
        {entries.length > MAX_ENTRIES && (
          <ListRow role={undefined} href={all} onClick={(e) => click(e, all)} leading={<Icon icon={Folder} size="sm"/>}>
            {entries.length - MAX_ENTRIES} more
          </ListRow>
        )}
      </FilesPanel>
      {readme && <ReadmePanel repoId={repoId} entry={readme} dir="" at={{kind: 'branch', ref: branch, sha}}/>}
    </>
  );
}

function EntryRow({owner, repo, branch, entry}: {owner: string; repo: string; branch: string; entry: APITreeEntry}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, codePath(owner, repo, `src/branch/${branch}/${entry.name}`));
  const parts = entryParts(entry);
  return (
    <ListRow role={undefined} href={href} onClick={(e) => click(e, href)} leading={parts.leading} trailing={parts.trailing}>
      {parts.main}
    </ListRow>
  );
}
