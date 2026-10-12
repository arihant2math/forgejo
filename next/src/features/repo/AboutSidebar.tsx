// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository home's side pane, in GitHub's order: About (description,
// website, topics, where it was forked from, Readme / License / Activity,
// stars, watchers, forks; the clone URLs and the archives are in the file
// bar's Code menu, CodeMenu.tsx, as on GitHub), Releases
// (the count, the latest, Tags) and Languages. Everything but the languages
// comes from the pool and the code cache (no request of its own: the README
// and license links read the root tree the file list loads); the languages
// are asked for once per commit of the default branch and kept in the code
// cache. Each part observes only the fields it shows.

import {Link} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, type ReactNode, type ReactElement, cloneElement, useId} from 'react';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {codePath} from '../../app/paths.ts';
import {useApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {APITree} from '../../protocol/types.gen.ts';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {codeTo} from '../code/nav.tsx';
import {README_ID, readmeOf} from '../code/Rendered.tsx';
import {usePool} from '../issues/cells.tsx';
import {fullDate, shortDate} from '../issues/format.ts';
import {languageShares, percent, licenseOf, plural, releaseSummary, tagCount} from './about.ts';
import {PulseIcon, BookIcon, EyeIcon, RepoForkedIcon, LinkIcon, LawIcon, StarIcon, TagIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Label, Heading, CounterLabel, ProgressBar} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';
import {TopicTag} from '@primer/react/experimental';

interface RepoProps {
  owner: string;
  repo: string;
  repoId: number;
}

export function AboutSidebar(props: RepoProps) {
  return (
    <>
      <SidebarSection title="About">
        <Description repoId={props.repoId}/>
        <ForkOf repoId={props.repoId}/>
        <SidebarLinks label="Repository">
          <TreeLinks {...props}/>
          <SidebarLink icon={PulseIcon}><Link to="/$owner/$repo/activity" params={{owner: props.owner, repo: props.repo}}>Activity</Link></SidebarLink>
          <Counts {...props}/>
        </SidebarLinks>
      </SidebarSection>
      <Releases {...props}/>
      <Languages repoId={props.repoId}/>
    </>
  );
}

/** The description, the website and the topics (or that there are none). */
const Description = observer(function Description({repoId}: {repoId: number}) {
  const r = usePool().model('Repository').get(repoId);
  if (!r) return null;
  const description = r.get('description');
  const website = r.get('website');
  const topics = r.get('topics');
  const site = /^https?:\/\//.test(website) ? website : '';
  if (!description && !site && topics.length === 0) return <p className="text-base text-muted">No description, website, or topics provided.</p>;
  return (
    <>
      {description && <p className="text-base text-default">{description}</p>}
      {site && (
        <SidebarLinks>
          <SidebarLink icon={LinkIcon} tone="accent"><a href={site} target="_blank" rel="noopener noreferrer"><span>{site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></a></SidebarLink>
        </SidebarLinks>
      )}
      {topics.length > 0 && <ul aria-label="Topics" className="flex flex-wrap gap-1">{topics.map((t) => <li key={t} className="flex"><TopicTag as="span">{t}</TopicTag></li>)}</ul>}
    </>
  );
});

/** "Forked from owner/name": the parent repository, when it is on this device. */
const ForkOf = observer(function ForkOf({repoId}: {repoId: number}) {
  const pool = usePool();
  const r = pool.model('Repository').get(repoId);
  const parentId = r?.get('fork') ? r.get('parent_id') : 0;
  const p = parentId > 0 ? pool.model('Repository').get(parentId) : undefined;
  if (!p) return null;
  return (
    <p className="flex min-w-0 items-center gap-2 text-base text-muted">
      <RepoForkedIcon size={16} className="shrink-0"/>
      <span className="shrink-0">Forked from</span>
      <RouterLink to="/$owner/$repo" params={{owner: p.get('owner_name'), repo: p.get('name')}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{p.get('full_name')}</RouterLink>
    </p>
  );
});

/** Readme (the panel below the files) and License (the file), read from the default branch's root tree. */
const TreeLinks = observer(function TreeLinks({owner, repo, repoId}: RepoProps) {
  const refs = refTable(usePool(), repoId);
  const sha = refs.branches.get(refs.defaultBranch);
  if (!sha) return null;
  return <RootFiles owner={owner} repo={repo} repoId={repoId} branch={refs.defaultBranch} sha={sha}/>;
});

function RootFiles({owner, repo, repoId, branch, sha}: RepoProps & {branch: string; sha: string}) {
  const app = useApp();
  const src = useSource();
  const click = useLinkClick();
  const key = CodeSource.treeKey(repoId, sha, '');
  // The same request as the file list's (one in flight per key): its answer paints both.
  const tree = useLoad(key, () => src.peek<APITree>(key), () => src.tree(repoId, sha, ''));
  if (tree.state !== 'ready') return null;
  const readme = readmeOf(tree.value.entries);
  const license = licenseOf(tree.value.entries);
  const licenseHref = license && hrefOf(app, codePath(owner, repo, `src/branch/${branch}/${license.name}`));
  const toReadme = (e: MouseEvent) => {
    const panel = document.getElementById(README_ID);
    if (!panel) return;
    e.preventDefault();
    panel.scrollIntoView({block: 'start'});
  };
  return (
    <>
      {readme && <SidebarLink icon={BookIcon}><a href={`#${README_ID}`} onClick={toReadme}>Readme</a></SidebarLink>}
      {license && licenseHref && (
        <SidebarLink icon={LawIcon}><a href={licenseHref} title={license.name} onClick={(e) => click(e, licenseHref)}>View license</a></SidebarLink>
      )}
    </>
  );
}

/** A row that opens a classic page (marked and hinted like every classic exit). */
function ClassicRow({owner, repo, path, icon, count, children}: {owner: string; repo: string; path: string; icon: OcticonType; count?: number; children: string}) {
  const app = useApp();
  return (
    <SidebarLink icon={icon} count={count}>
      <a href={classicHref(app, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`)} data-classic="" title={CLASSIC_HINT}>{children}</a>
    </SidebarLink>
  );
}

/** Stars, watchers and forks: one cell each (a new star re-renders its own line only). */
function Counts(props: RepoProps) {
  return (
    <>
      <Count {...props} field="stars_count" path="stars" icon={StarIcon} one="star"/>
      <Watching {...props}/>
      <Count {...props} field="forks_count" path="forks" icon={RepoForkedIcon} one="fork"/>
    </>
  );
}

const Count = observer(function Count({owner, repo, repoId, field, path, icon, one, many}: RepoProps & {field: 'stars_count' | 'watchers_count' | 'forks_count'; path: string; icon: OcticonType; one: string; many?: string}) {
  const r = usePool().model('Repository').get(repoId);
  if (!r) return null;
  const n = r.get(field);
  return <ClassicRow owner={owner} repo={repo} path={path} icon={icon} count={n}>{plural(n, one, many)}</ClassicRow>;
});

/** Watchers: the app's page (the people who watch the repository). */
const Watching = observer(function Watching({owner, repo, repoId}: RepoProps) {
  const r = usePool().model('Repository').get(repoId);
  if (!r) return null;
  const n = r.get('watchers_count');
  return <SidebarLink icon={EyeIcon} count={n}><Link to="/$owner/$repo/watchers" params={{owner, repo}}>{plural(n, 'watching', 'watching')}</Link></SidebarLink>;
});

/** Releases: the count, the latest (or that there are none), the rest, and the tags (their only way in). */
const Releases = observer(function Releases({owner, repo, repoId}: RepoProps) {
  const pool = usePool();
  const all = [...pool.model('Release').by('repo_id', repoId)].map((x) => x.data);
  const {count, latest} = releaseSummary(all);
  const tags = tagCount(all);
  const releasesTo = codeTo(owner, repo, 'releases');
  return (
    <SidebarSection title={count > 0 ? <Link {...releasesTo} className="min-w-0 truncate text-default hover:text-accent hover:underline">Releases</Link> : 'Releases'} count={count > 0 ? count : undefined}>
      {latest ?
        <Link {...releasesTo} className="interactive group flex min-w-0 items-start gap-2">
          <span className="flex h-5 shrink-0 items-center text-success"><TagIcon size={16} className="shrink-0"/></span>
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base font-semibold text-default group-hover:text-accent">{latest.name || latest.tag_name}</span>
              {latest.prerelease ? <Label variant="attention">Pre-release</Label> : <Label variant="success">Latest</Label>}
            </span>
            <time dateTime={latest.created_at} title={fullDate(latest.created_at)} className="text-sm text-muted">{shortDate(latest.created_at)}</time>
          </span>
        </Link> :
        <p className="text-base text-muted">No releases published.</p>}
      {count > 1 && <p className="text-base"><Link {...releasesTo} className="text-default hover:text-accent hover:underline">+ {count - 1} {plural(count - 1, 'release')}</Link></p>}
      {tags > 0 && (
        <SidebarLinks>
          <SidebarLink icon={TagIcon} count={tags}><Link {...codeTo(owner, repo, 'tags')}>{plural(tags, 'tag')}</Link></SidebarLink>
        </SidebarLinks>
      )}
    </SidebarSection>
  );
});

/** Languages: the default branch's, by size (nothing until known: it is the last section, nothing moves). */
const Languages = observer(function Languages({repoId}: {repoId: number}) {
  const refs = refTable(usePool(), repoId);
  const sha = refs.branches.get(refs.defaultBranch);
  if (!sha) return null;
  return <LanguagesAt repoId={repoId} sha={sha}/>;
});

function LanguagesAt({repoId, sha}: {repoId: number; sha: string}) {
  const src = useSource();
  const key = CodeSource.languagesKey(repoId, sha);
  const stats = useLoad(key, () => src.peek<Record<string, number>>(key), () => src.languages(repoId, sha));
  const shares = stats.state === 'ready' ? languageShares(stats.value) : [];
  if (!shares.length) return null;
  const total = shares.reduce((sum, share) => sum + share.value, 0);
  return (
    <SidebarSection title="Languages">
      <ProgressBar aria-label="Languages">{shares.map((share) => <ProgressBar.Item key={share.label} progress={share.value / total * 100} bg={languageColors[share.tone]} aria-label={`${share.label} ${percent(share.value, total)}`}/>)}</ProgressBar><ul aria-label="Language shares" className="flex flex-wrap gap-x-4 gap-y-2">{shares.map((share) => <li key={share.label} className="flex items-center gap-1 text-base"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill={languageDots[share.tone]}><circle cx="6" cy="6" r="5"/></svg><span>{share.label} <span className="text-sm text-muted">{percent(share.value, total)}</span></span></li>)}</ul>
    </SidebarSection>
  );
}

const languageDots = {1: 'var(--bgColor-accent-emphasis)', 2: 'var(--bgColor-success-emphasis)', 3: 'var(--bgColor-attention-emphasis)', 4: 'var(--bgColor-done-emphasis)', 5: 'var(--bgColor-danger-emphasis)', other: 'var(--bgColor-neutral-emphasis)'} as const;

const languageColors = {1: 'accent.emphasis', 2: 'success.emphasis', 3: 'attention.emphasis', 4: 'done.emphasis', 5: 'danger.emphasis', other: 'neutral.emphasis'} as const;

function SidebarSection({title, count, children}: {title: ReactNode; count?: number | undefined; children: ReactNode}) {
  const id = useId();
  return <section aria-labelledby={id} className="flex flex-col gap-4 border-b border-default py-4 last:border-b-0"><div className="flex items-center gap-2"><Heading id={id} as="h2" variant="small">{title}</Heading>{count !== undefined && <CounterLabel>{count}</CounterLabel>}</div>{children}</section>;
}
function SidebarLinks({label, children}: {label?: string; children: ReactNode}) {
  return <ul {...(label ? {'aria-label': label} : {})} className="flex flex-col gap-2">{children}</ul>;
}
function SidebarLink({icon: Icon, count, children, tone}: {icon: OcticonType; count?: number | undefined; children: ReactElement<{children?: ReactNode; className?: string; 'aria-label'?: string}>; tone?: 'accent'}) {
  return <li className="flex min-w-0 items-center gap-2 text-base"><Icon size={16} className="shrink-0 text-muted"/>{cloneElement(children, {className: `min-w-0 truncate hover:text-accent hover:underline ${tone === 'accent' ? 'text-accent' : 'text-default'}`, ...(count !== undefined && typeof children.props.children === 'string' ? {'aria-label': `${count.toLocaleString()} ${children.props.children}`} : {})}, <>{count !== undefined && <strong className="font-semibold">{count.toLocaleString()} </strong>}{children.props.children}</>)}</li>;
}
