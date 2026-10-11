// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The code views of a repository (PLAN §5.7, §7.1 Code), one route
// (`/{owner}/{repo}/*`, Forgejo's addresses; its own chunk): source (directories,
// files, blame), history (commits, one commit), branches, tags, releases,
// compare, a writer's release form, and Actions (runs, jobs, live logs). Every git read is addressed
// by SHA and cached (code/source.ts); refs resolve from the synced branches
// and tags, so what was seen once is there offline.

import {useNavigate, useParams} from '@tanstack/react-router';
import {type ReactNode, useEffect, useState} from 'react';
import {PageBody} from '../../app/shell/Frame.tsx';
import {abbreviatedCommit, codeRestOf, parseCodePath, shortSha} from '../../code/refs.ts';
import {Missing} from '../../app/Missing.tsx';
import {ShellNotFound} from '../../app/RouteStatus.tsx';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {ActionsView, RunView} from './Actions.tsx';
import {CompareView} from './Compare.tsx';
import {CommitView, CommitsView} from './History.tsx';
import {BranchesView, ReleasesView, TagsView} from './Refs.tsx';
import {ReleaseFormView} from './ReleaseForm.tsx';
import {SrcView} from './Src.tsx';
import {EmptyRepo, Unloaded} from './states.tsx';
import {useLoad, useSource} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {observer} from 'mobx-react-lite';
import {usePool} from '../issues/cells.tsx';
import {CodeIcon} from '@primer/octicons-react';

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
 * A code view's frame: the header (breadcrumb, the repository's tabs, the
 * view's title and controls) and the scroll container, which the body gets
 * (lists virtualize against it).
 */
export function CodeFrame({view, title, controls, docTitle, children}: {
  view: CodeViewProps; title: ReactNode; controls?: ReactNode; children: (scroller: HTMLDivElement | null) => ReactNode;
  /** The tab's title when the title is not text (a file's path: "internal/geo · acme/atlas"). */
  docTitle?: string | undefined;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <RepoHeader owner={view.owner} repo={view.repo} repoId={view.repoId} icon={CodeIcon} title={title}
        docTitle={docTitle ?? (typeof title === 'string' ? title : viewName(view.splat))}>{controls}</RepoHeader>
      <PageBody ref={setScroller}>{children(scroller)}</PageBody>
    </>
  );
}

/**
 * The code route's page (`/{owner}/{repo}/…`): a code view, or — for another address of a repository the app has no
 * page for (`/acme/atlas/settings/units`) — the not-found page with the classic one.
 */
export function CodePage() {
  const splat = codeRestOf(useParams({strict: false}));
  return parseCodePath(splat) || abbreviatedCommit(splat) ? <CodeViews/> : <ShellNotFound/>;
}

const CodeViews = observer(function CodeViews() {
  const {owner, repo, repoId} = useRepoPage();
  const pool = usePool();
  const splat = codeRestOf(useParams({strict: false}));
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={CodeIcon} title="Code"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  const props: CodeViewProps = {owner, repo, repoId, splat};
  const repoEmpty = pool.model('Repository').get(repoId)?.get('empty') === true;
  const route = parseCodePath(splat);
  // A commit named by an abbreviation of its SHA (`commit/edac59f`, `src/commit/edac59f/…`): looked up, then the
  // address with the full SHA.
  const short = abbreviatedCommit(splat);
  if (short) {
    return (
      <CodeFrame view={props} title={short.abbreviation}>
        {() => <ShortCommit {...props} key={splat} abbreviation={short.abbreviation} full={short.full}/>}
      </CodeFrame>
    );
  }
  if (!route) {
    return (
      <CodeFrame view={props} title="Code">
        {() => <Missing what="This page" description="This address does not name a code view." classic={`/${[owner, repo, ...splat.split('/').filter(Boolean)].map(encodeURIComponent).join('/')}`}/>}
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
    case 'release-form':
      return <ReleaseFormView {...props} key={`${String(repoId)}:${route.tag ?? ''}`} tag={route.tag}/>;
    case 'compare':
      return <CompareView {...props} key={`${String(repoId)}:${splat}`} base={route.base} head={route.head}/>;
    case 'actions':
      return <ActionsView {...props} key={repoId}/>;
    case 'run':
      return <RunView {...props} key={`${String(repoId)}:${String(route.run)}`} run={route.run} job={route.job}/>;
  }
});

/**
 * A code address with an abbreviated commit SHA (`commit/edac59f0a3`): Forgejo is asked for the full SHA, and the
 * address becomes the one with it (replaced: Back does not return to the lookup). Offline, or no such commit: said.
 */
function ShortCommit({owner, repo, repoId, abbreviation, full}: CodeViewProps & {abbreviation: string; full: (sha: string) => string}) {
  const src = useSource();
  const navigate = useNavigate();
  const sha = useLoad(`abbrev:${String(repoId)}:${abbreviation}`, () => undefined, () => src.resolveCommit(repoId, abbreviation));
  const found = sha.state === 'ready' ? sha.value : undefined;
  useEffect(() => {
    if (found) void navigate({...codeTo(owner, repo, full(found)), hash: true, replace: true});
  }, [found, navigate, owner, repo, full]);
  return <Unloaded loaded={sha.state === 'ready' ? {state: 'loading'} : sha} what={`The commit ${abbreviation}`}/>;
}
