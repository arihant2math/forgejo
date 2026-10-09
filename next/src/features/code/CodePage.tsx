// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The code views of a repository (PLAN §5.7, §7.1 Code), one route
// (`/-/next/code/{owner}/{repo}/*`, its own chunk): source (directories,
// files, blame), history (commits, one commit), branches, tags, releases,
// compare, and Actions (runs, jobs, live logs). Every git read is addressed
// by SHA and cached (code/source.ts); refs resolve from the synced branches
// and tags, so what was seen once is there offline.

import {useParams} from '@tanstack/react-router';
import {Code2} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {PageBody} from '../../app/shell/Frame.tsx';
import {parseCodePath, shortSha} from '../../code/refs.ts';
import {Missing} from '../../app/Missing.tsx';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {ActionsView, RunView} from './Actions.tsx';
import {CompareView} from './Compare.tsx';
import {CommitView, CommitsView} from './History.tsx';
import {BranchesView, ReleasesView, TagsView} from './Refs.tsx';
import {SrcView} from './Src.tsx';
import {EmptyRepo} from './states.tsx';
import {observer} from 'mobx-react-lite';
import {usePool} from '../issues/cells.tsx';

export interface CodeViewProps {
  owner: string;
  repo: string;
  repoId: number;
  /** The code path (for the tabs). */
  splat: string;
}

/** The browser tab's name of a code view whose title is not plain text (a path breadcrumb, a ref switcher). */
function viewName(splat: string): string {
  const r = parseCodePath(splat);
  switch (r?.view) {
    case 'blame': return 'Blame';
    case 'commits': return 'Commits';
    case 'commit': return `Commit ${shortSha(r.sha)}`;
    case 'compare': return 'Compare';
    case 'run': return `Run #${String(r.run)}`;
    default: return 'Code';
  }
}

/**
 * A code view's frame: the header (title, controls), the repository's tabs
 * and the scroll container, which the body gets (lists virtualize against it).
 */
export function CodeFrame({view, title, controls, docTitle, children}: {
  view: CodeViewProps; title: ReactNode; controls?: ReactNode; children: (scroller: HTMLDivElement | null) => ReactNode;
  /** The tab's title when the title is not text (a file's path: "internal/geo · acme/atlas"). */
  docTitle?: string | undefined;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <RepoHeader owner={view.owner} repo={view.repo} repoId={view.repoId} icon={Code2} title={title}
        docTitle={docTitle ?? (typeof title === 'string' ? title : viewName(view.splat))}>{controls}</RepoHeader>
      <PageBody ref={setScroller}>{children(scroller)}</PageBody>
    </>
  );
}

export const CodePage = observer(function CodePage() {
  const {owner, repo, repoId} = useRepoPage();
  const pool = usePool();
  const {_splat: splat = ''} = useParams({strict: false});
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={Code2} title="Code"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  const props: CodeViewProps = {owner, repo, repoId, splat};
  const repoEmpty = pool.model('Repository').get(repoId)?.get('empty') === true;
  const route = parseCodePath(splat);
  if (!route) {
    return (
      <CodeFrame view={props} title="Code">
        {() => <Missing what="This page" description="This address does not name a code view." classic={`/${[owner, repo, ...splat.replace(/\/?-$/, '').split('/').filter(Boolean)].map(encodeURIComponent).join('/')}`}/>}
      </CodeFrame>
    );
  }
  // An empty repository: one state on every code tab (what to push), not "Branch or tag not found".
  if (repoEmpty && route.view !== 'actions' && route.view !== 'run' && route.view !== 'releases') {
    return <CodeFrame view={props} title="Code">{() => <EmptyRepo owner={owner} repo={repo} repoId={repoId}/>}</CodeFrame>;
  }
  switch (route.view) {
    case 'src':
    case 'blame':
      return <SrcView {...props} key={`${String(repoId)}:${route.view}`} blame={route.view === 'blame'} kind={route.kind} rest={route.rest}/>;
    case 'commits':
      return <CommitsView {...props} key={`${String(repoId)}:${splat}`} kind={route.kind} rest={route.rest}/>;
    case 'commit':
      return <CommitView {...props} key={`${String(repoId)}:${route.sha}`} sha={route.sha}/>;
    case 'branches':
      return <BranchesView {...props} key={repoId}/>;
    case 'tags':
      return <TagsView {...props} key={repoId}/>;
    case 'releases':
      return <ReleasesView {...props} key={repoId}/>;
    case 'compare':
      return <CompareView {...props} key={`${String(repoId)}:${splat}`} base={route.base} head={route.head}/>;
    case 'actions':
      return <ActionsView {...props} key={repoId}/>;
    case 'run':
      return <RunView {...props} key={`${String(repoId)}:${String(route.run)}`} run={route.run} job={route.job}/>;
  }
});
