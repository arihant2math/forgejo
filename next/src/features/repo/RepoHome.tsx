// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's home (/{owner}/{repo}): what it is (description, topics,
// clone URL, latest commit, counts) from the pool, its top-level files and
// its README from the code cache (by commit and blob SHA: there offline
// once seen). The tabs lead to everything else. Its own chunk.

import {Link} from '@tanstack/react-router';
import {BookMarked, CircleDot, Copy, Folder, FolderGit2, GitBranch, GitPullRequest, Globe, Package, SquarePen, Star, GitFork} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {Fragment, type ReactNode, useEffect, useMemo} from 'react';
import {whenIdle} from '../../app/lazy.tsx';
import {sitePath} from '../../app/config.ts';
import {openCreate} from '../../app/create.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {notify} from '../../app/notices.ts';
import {codePath} from '../../app/paths.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {APITree, APITreeEntry} from '../../protocol/types.gen.ts';
import {
  Badge, Button, EmptyState, Icon, IconButton, ListRow, Property, PropertyList, PropertyValue, SkeletonText, TextLink,
} from '../../ui/index.ts';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {ReadmePanel, readmeOf} from '../code/Rendered.tsx';
import {Unloaded} from '../code/states.tsx';
import {entryParts, FilesPanel, RefCommit, treeOrder} from '../code/tree.tsx';
import {usePool} from '../issues/cells.tsx';
import {ago, fullDate, shortDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {cloneUrl, EmptyRepo} from '../code/states.tsx';

export function RepoHome() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={BookMarked} title="Overview"/>
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
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={BookMarked} title="Overview">
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
            <About owner={owner} repo={repo} repoId={repoId}/>
          </aside>
        </div>
      </PageBody>
    </>
  );
});

/** The description, the repository's kind and its topics. */
const Summary = observer(function Summary({repoId}: {repoId: number}) {
  const r = usePool().model('Repository').get(repoId)?.data;
  if (!r) return null;
  const flags = [r.private && 'Private', r.fork && 'Fork', r.mirror && 'Mirror', r.template && 'Template', r.archived && 'Archived'].filter((f): f is string => Boolean(f));
  return (
    <div className="flex flex-col gap-2">
      <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-fg">
        {r.name}
        {flags.map((f) => <Badge key={f} tone={f === 'Archived' ? 'warning' : 'neutral'}>{f}</Badge>)}
      </h2>
      {r.description ? <p className="max-w-lg text-md text-fg-muted">{r.description}</p> : <p className="text-md text-fg-subtle">No description.</p>}
      {r.topics.length > 0 && <div className="flex flex-wrap gap-1">{r.topics.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}</div>}
    </div>
  );
});

/** At most this many top-level entries are listed (the Code tab has them all). */
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
  const title = <RefCommit owner={owner} repo={repo} repoId={repoId} kind="branch" name={branch} sha={sha}/>;
  return <Tree owner={owner} repo={repo} repoId={repoId} sha={sha} branch={branch} title={title}/>;
});

function Tree({owner, repo, repoId, sha, branch, title}: {owner: string; repo: string; repoId: number; sha: string; branch: string; title: ReactNode}) {
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
      <FilesPanel title={title} actions={<Button size="sm" variant="ghost" asChild><a href={all} onClick={(e) => click(e, all)}>Browse code</a></Button>}>
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

/** The side pane: clone URL, website, counts, the latest release. */
const About = observer(function About({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const pool = usePool();
  const r = pool.model('Repository').get(repoId)?.data;
  let issues = 0;
  let pulls = 0;
  for (const i of pool.model('Issue').by('repo_id', repoId)) {
    if (i.get('state') !== 'open') continue;
    if (i.get('is_pull')) pulls++;
    else issues++;
  }
  const release = [...pool.model('Release').by('repo_id', repoId)].map((x) => x.data).filter((x) => !x.is_tag && !x.draft && !x.prerelease)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!r) return null;
  const clone = cloneUrl(app.config.app_url, owner, repo);
  const copy = () => {
    void navigator.clipboard.writeText(clone).then(() => {
      notify(app, {tone: 'success', title: 'Clone URL copied'});
    }, () => undefined);
  };
  return (
    <PropertyList>
      <Property label="Clone" stacked>
        <PropertyValue>
          <span className="flex min-w-0 items-start gap-1">
            {/* Whole, on the pane's full width: wrapped after a slash when it is longer, never mid-word. */}
            <span className="min-w-0 flex-1 py-0.5 font-mono text-code break-normal text-fg select-all">
              {clone.split(/(?<=\/)/).map((part, i) => <Fragment key={i}>{part}<wbr/></Fragment>)}
            </span>
            <IconButton size="sm" icon={Copy} label="Copy the clone URL" onClick={copy}/>
          </span>
        </PropertyValue>
      </Property>
      {r.website && /^https?:\/\//.test(r.website) && (
        <Property label="Website">
          <PropertyValue><span className="flex min-w-0 items-center gap-2"><Icon icon={Globe} size="sm"/><TextLink><a href={r.website} target="_blank" rel="noopener noreferrer">{r.website.replace(/^https?:\/\//, '')}</a></TextLink></span></PropertyValue>
        </Property>
      )}
      <Property label="Issues">
        <PropertyValue><span className="flex items-center gap-2"><Icon icon={CircleDot} size="sm"/><TextLink><Link to="/$owner/$repo/issues" params={{owner, repo}}>{issues} open</Link></TextLink></span></PropertyValue>
      </Property>
      <Property label="Pull requests">
        <PropertyValue><span className="flex items-center gap-2"><Icon icon={GitPullRequest} size="sm"/><TextLink><Link to="/$owner/$repo/pulls" params={{owner, repo}}>{pulls} open</Link></TextLink></span></PropertyValue>
      </Property>
      {release && (
        <Property label="Release">
          <PropertyValue>
            <span className="flex min-w-0 items-center gap-2">
              <Icon icon={Package} size="sm"/>
              <TextLink><Link to="/-/next/code/$owner/$repo/$" params={{owner, repo, _splat: 'releases/-'}}>{release.name || release.tag_name}</Link></TextLink>
              <span className="shrink-0 text-fg-subtle">{shortDate(release.created_at)}</span>
            </span>
          </PropertyValue>
        </Property>
      )}
      <Property label="Stars">
        <PropertyValue tone="muted"><span className="flex items-center gap-2 tabular-nums"><Icon icon={Star} size="sm"/>{r.stars_count}</span></PropertyValue>
      </Property>
      <Property label="Forks">
        <PropertyValue tone="muted"><span className="flex items-center gap-2 tabular-nums"><Icon icon={GitFork} size="sm"/>{r.forks_count}</span></PropertyValue>
      </Property>
      <Property label="Updated">
        <PropertyValue tone="muted"><time dateTime={r.updated_at} title={fullDate(r.updated_at)}>{ago(r.updated_at)}</time></PropertyValue>
      </Property>
      {r.fork && r.parent_id > 0 && <ForkOf parentId={r.parent_id}/>}
      {!r.empty && <Property label="Archive">
        <PropertyValue tone="muted"><TextLink><a href={sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${encodeURIComponent(r.default_branch)}.zip`)} download>{r.default_branch}.zip</a></TextLink></PropertyValue>
      </Property>}
    </PropertyList>
  );
});

const ForkOf = observer(function ForkOf({parentId}: {parentId: number}) {
  const p = usePool().model('Repository').get(parentId)?.data;
  if (!p) return null;
  return (
    <Property label="Forked from">
      <PropertyValue><TextLink><Link to="/$owner/$repo" params={{owner: p.owner_name, repo: p.name}}>{p.full_name}</Link></TextLink></PropertyValue>
    </Property>
  );
});
