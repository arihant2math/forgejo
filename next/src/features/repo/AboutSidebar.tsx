// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Languages are cached by default-branch commit; README and license reuse the file list's root tree.

import {Link} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, type MouseEventHandler, type ReactNode, useId} from 'react';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {emojify} from '../../app/emoji.ts';
import {sitePath} from '../../app/config.ts';
import {useLinkClick} from '../../app/links.ts';
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
import {Label, Heading, CounterLabel, Link as PrimerLink, ProgressBar} from '@primer/react';
import {TopicTag} from '@primer/react/experimental';
import {PrimaryLink} from '../../app/routerLinks.tsx';

interface RepoProps {
  owner: string;
  repo: string;
  repoId: number;
}

/** An in-app destination for a sidebar link: its href, and a click that navigates in place. */
function useInApp(): (path: string) => {href: string; onClick: MouseEventHandler<HTMLAnchorElement>} {
  const app = useApp();
  const click = useLinkClick();
  return (path) => {
    const href = sitePath(app.config, path);
    return {href, onClick: (e) => { click(e, href); }};
  };
}

export function AboutSidebar(props: RepoProps) {
  const inApp = useInApp();
  return (
    <>
      <SidebarSection title="About">
        <Description repoId={props.repoId}/>
        <SidebarLinks label="Repository">
          <TreeLinks {...props}/>
          <SidebarLink icon={PulseIcon} {...inApp(codePath(props.owner, props.repo, 'activity'))}>Activity</SidebarLink>
          <Counts {...props}/>
        </SidebarLinks>
      </SidebarSection>
      <Releases {...props}/>
      <Languages repoId={props.repoId}/>
    </>
  );
}

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
      {description && <p className="text-base text-default">{emojify(description)}</p>}
      {site && (
        <SidebarLinks>
          <SidebarLink icon={LinkIcon} href={site} tone="accent" external>{site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</SidebarLink>
        </SidebarLinks>
      )}
      {topics.length > 0 && <ul aria-label="Topics" className="flex flex-wrap gap-1">{topics.map((t) => <li key={t} className="flex"><TopicTag as="span">{t}</TopicTag></li>)}</ul>}
    </>
  );
});

const TreeLinks = observer(function TreeLinks({owner, repo, repoId}: RepoProps) {
  const refs = refTable(usePool(), repoId);
  const sha = refs.branches.get(refs.defaultBranch);
  if (!sha) return null;
  return <RootFiles owner={owner} repo={repo} repoId={repoId} branch={refs.defaultBranch} sha={sha}/>;
});

function RootFiles({owner, repo, repoId, branch, sha}: RepoProps & {branch: string; sha: string}) {
  const inApp = useInApp();
  const src = useSource();
  const key = CodeSource.treeKey(repoId, sha, '');
  // Share the file list's in-flight request so one answer paints both.
  const tree = useLoad(key, () => src.peek<APITree>(key), () => src.tree(repoId, sha, ''));
  if (tree.state !== 'ready') return null;
  const readme = readmeOf(tree.value.entries);
  const license = licenseOf(tree.value.entries);
  const toReadme = (e: MouseEvent) => {
    const panel = document.getElementById(README_ID);
    if (!panel) return;
    e.preventDefault();
    panel.scrollIntoView({block: 'start'});
  };
  return (
    <>
      {readme && <SidebarLink icon={BookIcon} href={`#${README_ID}`} onClick={toReadme}>Readme</SidebarLink>}
      {license && <SidebarLink icon={LawIcon} {...inApp(codePath(owner, repo, `src/branch/${branch}/${license.name}`))} title={license.name}>View license</SidebarLink>}
    </>
  );
}

function ClassicRow({owner, repo, path, icon, count, children}: {owner: string; repo: string; path: string; icon: OcticonType; count?: number; children: string}) {
  const app = useApp();
  return (
    <SidebarLink icon={icon} count={count} href={classicHref(app, codePath(owner, repo, path))} title={CLASSIC_HINT} classic>{children}</SidebarLink>
  );
}

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

const Watching = observer(function Watching({owner, repo, repoId}: RepoProps) {
  const inApp = useInApp();
  const r = usePool().model('Repository').get(repoId);
  if (!r) return null;
  const n = r.get('watchers_count');
  return <SidebarLink icon={EyeIcon} count={n} {...inApp(codePath(owner, repo, 'watchers'))}>{plural(n, 'watching', 'watching')}</SidebarLink>;
});

const Releases = observer(function Releases({owner, repo, repoId}: RepoProps) {
  const inApp = useInApp();
  const pool = usePool();
  const all = [...pool.model('Release').by('repo_id', repoId)].map((x) => x.data);
  const {count, latest} = releaseSummary(all);
  const tags = tagCount(all);
  const releasesTo = codeTo(owner, repo, 'releases');
  return (
    <SidebarSection title={count > 0 ? <PrimaryLink {...releasesTo} className="min-w-0 truncate">Releases</PrimaryLink> : 'Releases'} count={count > 0 ? count : undefined}>
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
      {count > 1 && <p className="text-base"><PrimaryLink {...releasesTo}>+ {count - 1} {plural(count - 1, 'release')}</PrimaryLink></p>}
      {tags > 0 && (
        <SidebarLinks>
          <SidebarLink icon={TagIcon} count={tags} {...inApp(codePath(owner, repo, 'tags'))}>{plural(tags, 'tag')}</SidebarLink>
        </SidebarLinks>
      )}
    </SidebarSection>
  );
});

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
      <ProgressBar aria-label="Languages">{shares.map((share) => <ProgressBar.Item key={share.label} progress={share.value / total * 100} bg={`${LANGUAGE_TONES[share.tone]}.emphasis`} aria-label={`${share.label} ${percent(share.value, total)}`}/>)}</ProgressBar><ul aria-label="Language shares" className="flex flex-wrap gap-x-4 gap-y-2">{shares.map((share) => <li key={share.label} className="flex items-center gap-1 text-base"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill={`var(--bgColor-${LANGUAGE_TONES[share.tone]}-emphasis)`}><circle cx="6" cy="6" r="5"/></svg><span>{share.label} <span className="text-sm text-muted">{percent(share.value, total)}</span></span></li>)}</ul>
    </SidebarSection>
  );
}

/** The bar and the legend's dots share Primer's emphasis background of each slot. */
const LANGUAGE_TONES = {1: 'accent', 2: 'success', 3: 'attention', 4: 'done', 5: 'danger', other: 'neutral'} as const;

function SidebarSection({title, count, children}: {title: ReactNode; count?: number | undefined; children: ReactNode}) {
  const id = useId();
  return <section aria-labelledby={id} className="flex flex-col gap-4 border-b border-default py-4 last:border-b-0"><div className="flex items-center gap-2"><Heading id={id} as="h2" variant="small">{title}</Heading>{count !== undefined && <CounterLabel>{count}</CounterLabel>}</div>{children}</section>;
}
function SidebarLinks({label, children}: {label?: string; children: ReactNode}) {
  return <ul {...(label ? {'aria-label': label} : {})} className="flex flex-col gap-2">{children}</ul>;
}
/** GitHub's sidebar rows: Link--muted (accent for the website), a count first, as in "12 stars". */
function SidebarLink({icon: Icon, href, onClick, count, tone, title, classic = false, external = false, children}: {
  icon: OcticonType; href: string; onClick?: MouseEventHandler<HTMLAnchorElement> | undefined; count?: number | undefined; tone?: 'accent';
  title?: string | undefined; classic?: boolean; external?: boolean; children: string;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-base">
      <Icon size={16} className="shrink-0 text-muted"/>
      <PrimerLink href={href} onClick={onClick} muted={tone !== 'accent'} title={title} className="min-w-0 truncate"
        data-classic={classic ? '' : undefined} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
        aria-label={count === undefined ? undefined : `${count.toLocaleString()} ${children}`}>
        {count !== undefined && <strong className="font-semibold">{count.toLocaleString()} </strong>}{children}
      </PrimerLink>
    </li>
  );
}
