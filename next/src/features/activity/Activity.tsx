// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Pulse uses pool data; commit history and contributor graphs are cached by default-branch head SHA.

import {createLink, Link, useNavigate, useParams} from '@tanstack/react-router';
import {autorun} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {connectivity} from '../../app/online.ts';
import {codePath} from '../../app/paths.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {Entity} from '../../data/entity.ts';
import {issueState} from '../../intents/view.ts';
import type {APIActivityAuthor, APICommitActivity, APIContributors} from '../../protocol/types.gen.ts';
import {DenseRow} from '../home/DenseRow.tsx';
import {DashboardSection} from '../home/DashboardSection.tsx';
import {Avatar, BranchName, Heading, NavList} from '@primer/react';
import {clsx} from 'clsx';
import {refTable, useLoad, useSource} from '../code/hooks.ts';
import {Unloaded} from '../code/states.tsx';
import {closedPager} from '../issues/closed.ts';
import {AgoCell, PendingCell, RefCell, StateIcon, TitleCell, useOverlay, usePool} from '../issues/cells.tsx';
import {issuePath} from '../issues/edits.ts';
import {shortDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {ColumnChart, DivergingChart, Meter, Split} from './charts.tsx';
import {
  commitSummary, fillWeeks, lastWeeks, yearAtLeast, type Period, PERIODS, parsePeriod, periodLabel, periodStart, pulse, type PulseIssue, type PulseRelease, weekOf,
} from './pulse.ts';
import {GraphIcon, IssueClosedIcon, IssueOpenedIcon, CloudOfflineIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon, CommentDiscussionIcon, TagIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Button, LinkButton, ActionMenu, ActionList} from '@primer/react';
import {SkeletonBox, Blankslate} from '@primer/react/experimental';
import {RouterLink} from '../../app/routerLinks.tsx';

type Section = 'pulse' | 'contributors' | 'code-frequency' | 'recent-commits';

const SECTIONS = [
  {id: 'pulse', label: 'Pulse', to: '/$owner/$repo/activity'},
  {id: 'contributors', label: 'Contributors', to: '/$owner/$repo/activity/contributors'},
  {id: 'recent-commits', label: 'Commits', to: '/$owner/$repo/activity/recent-commits'},
  {id: 'code-frequency', label: 'Code frequency', to: '/$owner/$repo/activity/code-frequency'},
] as const satisfies readonly {id: Section; label: string; to: string}[];

const ActivityNavItem = createLink(NavList.Item);

/** Longer periods may exceed the summary's recency window and need closed-tier data. */
const LONG: ReadonlySet<Period> = new Set(['quarterly', 'semiyearly', 'yearly']);

const FIRST_ROWS = 10;
const MAX_ROWS = 100;

function ActivityPage({section, controls, children}: {section: Section; controls?: ReactNode; children: (repoId: number, owner: string, repo: string) => ReactNode}) {
  const {owner, repo, repoId} = useRepoPage();
  const title = SECTIONS.find((s) => s.id === section)?.label ?? 'Pulse';
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={GraphIcon} title="Activity" docTitle={`${title} · Activity`}>{repoId !== undefined && controls}</RepoHeader>
      <PageBody>
        {repoId === undefined ? <Unavailable owner={owner} repo={repo}/> : (
          <div className="flex min-h-full flex-col @xl:flex-row">
            <SideNav owner={owner} repo={repo} repoId={repoId} section={section}/>
            <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 @xl:px-8 @xl:py-6">{children(repoId, owner, repo)}</div>
          </div>
        )}
      </PageBody>
    </>
  );
}

const SideNav = observer(function SideNav({owner, repo, repoId, section}: {owner: string; repo: string; repoId: number; section: Section}) {
  const src = useSource();
  const sha = useHead(repoId).sha;
  const warm = () => {
    if (sha) void src.contributors(repoId, sha).catch(() => undefined);
  };
  return (
    <NavList aria-label="Activity pages" className="shrink-0 @xl:sticky @xl:top-0 @xl:w-pane @xl:self-start">
      {SECTIONS.map((s) => (
        <ActivityNavItem key={s.id} to={s.to} params={{owner, repo}} activeProps={{}} activeOptions={{exact: true}} aria-current={s.id === section ? 'page' : false}
          {...(s.id === 'pulse' ? {} : {onPointerEnter: warm, onFocus: warm})}>
          {s.label}
        </ActivityNavItem>
      ))}
    </NavList>
  );
});

function useHead(repoId: number): {branch: string; sha: string | undefined; empty: boolean} {
  const pool = usePool();
  const refs = refTable(pool, repoId);
  return {branch: refs.defaultBranch, sha: refs.branches.get(refs.defaultBranch), empty: pool.model('Repository').get(repoId)?.get('empty') ?? false};
}


export function ActivityPulse() {
  const params: {period?: string} = useParams({strict: false});
  const period = parsePeriod(params.period);
  return (
    <ActivityPage section="pulse" controls={<PeriodMenu period={period}/>}>
      {(repoId, owner, repo) => <PulseView key={repoId} owner={owner} repo={repo} repoId={repoId} period={period}/>}
    </ActivityPage>
  );
}

function PeriodMenu({period}: {period: Period}) {
  const navigate = useNavigate();
  const {owner = '', repo = ''} = useParams({strict: false});
  return (
    <ActionMenu>
      <ActionMenu.Button size="small" aria-label={`Period: ${periodLabel(period)}`}>Period: {periodLabel(period)}</ActionMenu.Button>
      <ActionMenu.Overlay><ActionList>
        <ActionList.Group selectionVariant="single">
          {PERIODS.map((p) => <ActionList.Item key={p.id} selected={period === p.id} onSelect={() => {
            void navigate({to: '/$owner/$repo/activity/$period', params: {owner, repo, period: p.id}, resetScroll: false});
          }}>{p.label}</ActionList.Item>)}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}

interface Row extends PulseIssue {
  issue: Entity<'Issue'>;
}

interface ReleaseRow extends PulseRelease {
  release: Entity<'Release'>;
}

const PulseView = observer(function PulseView({owner, repo, repoId, period}: {owner: string; repo: string; repoId: number; period: Period}) {
  const pool = usePool();
  const overlay = useOverlay();
  const {data} = useSession();
  // Freeze the count window until the period changes.
  const now = useMemo(() => Date.now(), [period]); // eslint-disable-line react-hooks/exhaustive-deps -- recount per period
  const from = periodStart(period, now);
  const pulls = pool.model('PullRequest');
  const rows: Row[] = [];
  for (const issue of pool.model('Issue').by('repo_id', repoId)) {
    if (issue.id <= 0) continue; // created on this device, not in Forgejo yet
    const d = issue.data;
    const pr = d.is_pull ? [...pulls.by('issue_id', issue.id)][0]?.data : undefined;
    rows.push({
      issue, id: issue.id, is_pull: d.is_pull, state: issueState(overlay, issue), poster_id: d.poster_id, created_at: d.created_at, updated_at: d.updated_at,
      closed_at: d.closed_at, merged: pr?.merged, merged_at: pr?.merged_at,
    });
  }
  const releases: ReleaseRow[] = [...pool.model('Release').by('repo_id', repoId)].map((release) => ({...release.data, release}));
  const p = pulse(rows, releases, from, Infinity);

  const pager = closedPager(data, `repo:${String(repoId)}`);
  const long = LONG.has(period);
  useEffect(() => {
    if (!long) return undefined;
    return autorun(() => {
      if (!pager.done && !pager.loading) pager.more();
    });
  }, [pager, long]);

  const loading = data.status.loading > 0 && rows.length === 0 && releases.length === 0;
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const range = `${shortDate(new Date(from).toISOString(), 0)} – ${shortDate(new Date(now).toISOString(), 0)}`;
  return (
    <>
      <DashboardSection label="Overview" title={<><span className="text-default">Overview</span><span className="text-sm font-normal text-muted">{range}</span></>}>
        {loading ? <OverviewSkeleton/> : (
          <div className="flex flex-col">
            <div className="flex flex-col gap-4 border-b border-muted p-4 @xl:flex-row">
              <Share title={`${count(p.activePulls)} active pull ${plural(p.activePulls, 'request')}`} a={p.merged.items.length} b={p.opened.items.length}
                aLabel="merged" bLabel="open"/>
              <Share title={`${count(p.activeIssues)} active ${plural(p.activeIssues, 'issue')}`} a={p.closed.items.length} b={p.created.items.length}
                aLabel="closed" bLabel="new"/>
            </div>
            <div className="flex">
              <Stat href="#merged" icon={GitMergeIcon} tone="done" value={p.merged.items.length} label={`merged pull ${plural(p.merged.items.length, 'request')}`}/>
              <Stat href="#opened" icon={GitPullRequestIcon} tone="success" value={p.opened.items.length} label={`open pull ${plural(p.opened.items.length, 'request')}`}/>
              <Stat href="#closed" icon={IssueClosedIcon} tone="done" value={p.closed.items.length} label={`closed ${plural(p.closed.items.length, 'issue')}`}/>
              <Stat href="#new" icon={IssueOpenedIcon} tone="success" value={p.created.items.length} label={`new ${plural(p.created.items.length, 'issue')}`}/>
            </div>
          </div>
        )}
      </DashboardSection>
      {long && <OlderNote pager={pager}/>}
      <Commits owner={owner} repo={repo} repoId={repoId} from={from}/>
      {p.releases.items.length > 0 && (
        <DashboardSection label="Releases" title={<><TagIcon size={16}/><span className="text-default">{count(p.releases.items.length)} {plural(p.releases.items.length, 'release')} published</span><span className="text-sm font-normal text-muted">by {count(p.releases.authors)} {plural(p.releases.authors, 'person', 'people')}</span></>}>
          {p.releases.items.slice(0, MAX_ROWS).map((r) => <ReleaseItem key={r.id} owner={owner} repo={repo} release={r.release}/>)}
        </DashboardSection>
      )}
      <List id="merged" icon={GitMergeIcon} title="merged pull" noun="request" items={p.merged.items} authors={p.merged.authors} at={(r) => r.merged_at ?? r.updated_at}
        all={`${base}/pulls?state=closed&sort=recentupdate`}/>
      <List id="opened" icon={GitPullRequestIcon} title="open pull" noun="request" items={p.opened.items} authors={p.opened.authors} at={(r) => r.created_at}
        all={`${base}/pulls?sort=newest`}/>
      <List id="closed" icon={IssueClosedIcon} title="closed" noun="issue" items={p.closed.items} authors={p.closed.authors} at={(r) => r.closed_at ?? r.updated_at}
        all={`${base}/issues?state=closed&sort=recentupdate`}/>
      <List id="new" icon={IssueOpenedIcon} title="new" noun="issue" items={p.created.items} authors={p.created.authors} at={(r) => r.created_at}
        all={`${base}/issues?state=all&sort=newest`}/>
      <List id="unresolved" icon={CommentDiscussionIcon} title="unresolved" noun="conversation" items={p.unresolved} at={(r) => r.updated_at}
        all={`${base}/issues?sort=recentupdate`}
        hint="Opened before this period, still open, and updated in it."/>
    </>
  );
});

const count = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-busy>
      <SkeletonBox className="h-3 w-48"/>
      <SkeletonBox className="h-2 w-full"/>
      <SkeletonBox className="h-3 w-64"/>
    </div>
  );
}

function Share({title, a, b, aLabel, bLabel}: {title: string; a: number; b: number; aLabel: string; bLabel: string}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <span className="text-base font-semibold text-default tabular-nums">{title}</span>
      <Split a={a} b={b} label={`${count(a)} ${aLabel}, ${count(b)} ${bLabel}`}/>
    </div>
  );
}

const TONES = {done: 'text-done', success: 'text-success'} as const;

function Stat({href, icon: StatIcon, tone, value, label}: {href: string; icon: OcticonType; tone: keyof typeof TONES; value: number; label: string}) {
  return (
    <a href={href} className="flex min-w-0 flex-1 flex-col items-center gap-1 px-2 py-3 text-center hover:bg-control-transparent-hover focus-visible:outline-focus">
      <span className={clsx('flex items-center gap-1 text-xl font-semibold tabular-nums', TONES[tone])}><StatIcon size={16}/>{count(value)}</span>
      <span className="text-base text-muted">{label}</span>
    </a>
  );
}

const OlderNote = observer(function OlderNote({pager}: {pager: ReturnType<typeof closedPager>}) {
  if (pager.done) return null;
  const offline = !connectivity.online;
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      {offline && <CloudOfflineIcon size={12} className="shrink-0"/>}
      {offline ?
        'Older closed issues and pull requests are not all on this device: the counts may miss some until you are online.' :
        'Counting older closed issues and pull requests…'}
    </p>
  );
});

function List({id, icon: SectionIcon, title, noun, items, authors, at, all, hint}: {
  id: string;
  icon: OcticonType;
  title: string;
  noun: string;
  items: Row[];
  authors?: number;
  at: (r: Row) => string;
  all: string;
  hint?: string;
}) {
  const app = useApp();
  const click = useLinkClick();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const shown = items.slice(0, open ? MAX_ROWS : FIRST_ROWS);
  const href = hrefOf(app, all);
  return (
    <section id={id} className="scroll-mt-4">
      <DashboardSection label={`${title} ${noun}s`} title={<>
        <SectionIcon size={16}/>
        <span className="text-default tabular-nums">{count(items.length)} {title} {plural(items.length, noun)}</span>
        {authors !== undefined && <span className="text-sm font-normal text-muted tabular-nums">by {count(authors)} {plural(authors, 'person', 'people')}</span>}
        {hint && <span className="truncate text-sm font-normal text-muted max-md:hidden">· {hint}</span>}
      </>} actions={items.length > shown.length ? (
        open ?
          <LinkButton variant="invisible" size="small" href={href} onClick={(e) => {
            click(e, href);
          }}>View in the list</LinkButton> :
          <Button variant="invisible" size="small" type="button" onClick={() => {
            setOpen(true);
          }}>Show all {count(items.length)}</Button>
      ) : undefined}>
        {shown.map((r) => <IssueItem key={r.id} issue={r.issue} at={at(r)}/>)}
      </DashboardSection>
    </section>
  );
}

const IssueItem = observer(function IssueItem({issue, at}: {issue: Entity<'Issue'>; at: string}) {
  const app = useApp();
  const click = useLinkClick();
  const path = issuePath(app, issue);
  const href = path && hrefOf(app, path);
  return (
    <DenseRow role={undefined} href={href} onClick={(e) => {
      if (href) click(e, href);
    }} leading={<StateIcon issue={issue}/>} trailing={<>
      <PendingCell issueId={issue.id}/>
      <RefCell repo="" number={issue.get('number')}/>
      <AgoCell at={at}/>
    </>}>
      <TitleCell issue={issue}/>
    </DenseRow>
  );
});

const ReleaseItem = observer(function ReleaseItem({owner, repo, release}: {owner: string; repo: string; release: Entity<'Release'>}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, codePath(owner, repo, 'releases'));
  const r = release.data;
  return (
    <DenseRow role={undefined} href={href} onClick={(e) => {
      click(e, href);
    }} leading={<TagIcon size={16}/>} trailing={<>
      {r.prerelease && <span>Pre-release</span>}
      <span className="font-mono">{r.tag_name}</span>
      <AgoCell at={r.created_at}/>
    </>}>
      {r.name || r.tag_name}
    </DenseRow>
  );
});

function Author({who, size}: {who: APIActivityAuthor; size: 'sm' | 'md'}) {
  const name = who.name !== '' ? who.name : who.login;
  return (
    <>
      {who.avatar_url !== '' ? <Avatar alt={name} src={who.avatar_url} size={size === 'sm' ? 20 : 32}/> : <span aria-hidden className={size === 'sm' ? 'size-5 shrink-0' : 'size-8 shrink-0'}/>}
      {who.login ?
        <Link to="/$owner" params={{owner: who.login}} className="truncate text-default hover:text-accent hover:underline">{name}</Link> :
        <span className="truncate text-default">{name !== '' ? name : 'Someone'}</span>}
    </>
  );
}

const Commits = observer(function Commits({owner, repo, repoId, from}: {owner: string; repo: string; repoId: number; from: number}) {
  const {branch, sha, empty} = useHead(repoId);
  const title = <><GitCommitIcon size={16}/><span className="text-default">Commits</span>{branch && <BranchName as="span">{branch}</BranchName>}</>;
  if (!sha) {
    return (
      <DashboardSection label="Commits" title={title} padded>
        <p className="text-sm text-muted">{empty ? 'This repository has no commits yet.' : 'Its branches are not on this device yet.'}</p>
      </DashboardSection>
    );
  }
  return <CommitsAt key={sha} owner={owner} repo={repo} repoId={repoId} sha={sha} branch={branch} from={from} title={title}/>;
});

function CommitsAt({owner, repo, repoId, sha, branch, from, title}: {owner: string; repo: string; repoId: number; sha: string; branch: string; from: number; title: ReactNode}) {
  const src = useSource();
  const key = CodeSource.activityKey(repoId, sha);
  const loaded = useLoad(key, () => src.peek<APICommitActivity>(key), () => src.commitActivity(repoId, sha));
  if (loaded.state !== 'ready') {
    return (
      <DashboardSection label="Commits" title={title}>
        <Unloaded loaded={loaded} what="This repository's history" skeleton={<CommitsSkeleton/>}/>
      </DashboardSection>
    );
  }
  const a = loaded.value;
  const s = commitSummary(a, from);
  const top = s.authors.slice(0, 10);
  const most = top[0]?.commits ?? 0;
  const atLeast = s.partial ? 'at least ' : '';
  return (
    <DashboardSection label="Commits" title={title} padded>
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          Excluding merges, <strong className="font-semibold text-default">{atLeast}{count(s.authors.length)} {plural(s.authors.length, 'author')}</strong>{' '}
          {s.authors.length === 1 ? 'has' : 'have'} pushed <strong className="font-semibold text-default">{atLeast}{count(s.commits)} {plural(s.commits, 'commit')}</strong> to{' '}
          <span className="font-mono">{branch}</span>, with <span className="text-success tabular-nums">{count(s.additions)} {plural(s.additions, 'addition')}</span> and{' '}
          <span className="text-danger tabular-nums">{count(s.deletions)} {plural(s.deletions, 'deletion')}</span>.
        </p>
        {top.length > 0 && (
          <div className="flex flex-col gap-2">
            <Heading as="h3" variant="small">Top committers</Heading>
            <ol className="flex flex-col gap-2">
              {top.map(({author, commits}) => {
                const who = a.authors[author] ?? {name: 'Someone', login: '', avatar_url: ''};
                return (
                  <li key={author} className="flex items-center gap-2">
                    <span className="flex h-5 w-32 min-w-0 shrink-0 items-center gap-2 @xl:w-48"><Author who={who} size="sm"/></span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Meter value={commits} max={most}/>
                      <span className="w-20 shrink-0 text-right text-sm text-muted tabular-nums">{count(commits)} {plural(commits, 'commit')}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <p className="text-base">
          <RouterLink to="/$owner/$repo/activity/contributors" params={{owner, repo}} className="min-w-0 truncate">All contributors</RouterLink>
        </p>
      </div>
    </DashboardSection>
  );
}

function CommitsSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-busy>
      <SkeletonBox className="h-3 w-96"/>
      {['w-56', 'w-40', 'w-32'].map((w) => <span key={w} className="flex items-center gap-2"><SkeletonBox className="size-4"/><SkeletonBox className={`h-2 ${w}`}/></span>)}
    </div>
  );
}


function Statistics({repoId, children, skeleton}: {repoId: number; children: (s: APIContributors, branch: string) => ReactNode; skeleton: ReactNode}) {
  const {branch, sha, empty} = useHead(repoId);
  if (!sha) {
    return <Blankslate spacious><Blankslate.Visual><GitCommitIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{empty ? 'No commits yet' : 'No code on this device yet'}</Blankslate.Heading><Blankslate.Description>{empty ? 'This repository has no commits to count.' : 'Its branches have not arrived yet.'}</Blankslate.Description></Blankslate>;
  }
  return <StatisticsAt key={sha} repoId={repoId} sha={sha} branch={branch} skeleton={skeleton}>{children}</StatisticsAt>;
}

function StatisticsAt({repoId, sha, branch, children, skeleton}: {repoId: number; sha: string; branch: string; children: (s: APIContributors, branch: string) => ReactNode; skeleton: ReactNode}) {
  const src = useSource();
  const key = CodeSource.contributorsKey(repoId, sha);
  const loaded = useLoad(key, () => src.peek<APIContributors>(key), () => src.contributors(repoId, sha));
  if (loaded.state !== 'ready') return <Unloaded loaded={loaded} what="These statistics" skeleton={skeleton}/>;
  if (!loaded.value.total.length) return <Blankslate spacious><Blankslate.Visual><GitCommitIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No commits to count</Blankslate.Heading><Blankslate.Description>The default branch has only merge commits.</Blankslate.Description></Blankslate>;
  return <>{children(loaded.value, branch)}</>;
}

function ChartSkeleton({rows = 1}: {rows?: number}) {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      {Array.from({length: rows}, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-default p-4">
          <SkeletonBox className="h-3 w-48"/>
          <SkeletonBox className={i === 0 ? 'h-40 w-full' : 'h-12 w-full'}/>
        </div>
      ))}
    </div>
  );
}

const weekLabel = (w: number) => `Week of ${shortDate(new Date(w).toISOString(), 0)}`;
const dateLabel = (w: number | undefined) => (w === undefined ? undefined : shortDate(new Date(w).toISOString(), 0));

const MAX_CONTRIBUTORS = 50;

export function ActivityContributors() {
  return (
    <ActivityPage section="contributors">
      {(repoId) => (
        <Statistics repoId={repoId} skeleton={<ChartSkeleton rows={4}/>}>
          {(s, branch) => <ContributorsView stats={s} branch={branch}/>}
        </Statistics>
      )}
    </ActivityPage>
  );
}

function ContributorsView({stats, branch}: {stats: APIContributors; branch: string}) {
  const total = yearAtLeast(stats.total);
  const first = total[0]?.week;
  const last = total.at(-1)?.week;
  const commits = total.reduce((n, w) => n + w.commits, 0);
  const shown = stats.contributors.slice(0, MAX_CONTRIBUTORS);
  const rest = stats.contributors.slice(MAX_CONTRIBUTORS);
  return (
    <>
      <DashboardSection label="Commits over time" title={<><span className="text-default">Commits to <span className="font-mono">{branch}</span></span><span>excluding merges</span></>} padded>
        <ColumnChart label={`Commits per week to ${branch}`} size="lg" unit="commits"
          columns={total.map((w) => ({label: weekLabel(w.week), value: w.commits}))}
          caption={`${count(commits)} ${plural(commits, 'commit')} by ${count(stats.contributors.length)} ${plural(stats.contributors.length, 'contributor')}`}
          start={dateLabel(first)} end={dateLabel(last)}/>
      </DashboardSection>
      <ol className="flex flex-col gap-4">
        {shown.map((c, i) => {
          const weeks = fillWeeks(c.weeks, first, last);
          const add = c.weeks.reduce((n, w) => n + w.additions, 0);
          const del = c.weeks.reduce((n, w) => n + w.deletions, 0);
          return (
            <li key={`${c.login}:${c.name}:${String(i)}`} className="flex min-w-0 flex-col gap-2 rounded-md border border-default bg-default p-4">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2 font-semibold"><Author who={c} size="md"/></span>
                  <span className="text-sm text-muted tabular-nums">
                    {count(c.commits)} {plural(c.commits, 'commit')} · <span className="text-success">+{count(add)}</span> <span className="text-danger">−{count(del)}</span>
                  </span>
                </div>
                <span className="ml-auto text-sm text-muted tabular-nums">#{i + 1}</span>
              </div>
              <ColumnChart label={`Commits per week by ${c.name || c.login}`} size="sm" unit="commits" columns={weeks.map((w) => ({label: weekLabel(w.week), value: w.commits}))}/>
            </li>
          );
        })}
      </ol>
      {rest.length > 0 && (
        <p className="text-sm text-muted">
          And {count(rest.length)} more: {rest.map((c) => `${c.name || c.login} (${count(c.commits)})`).join(', ')}.
        </p>
      )}
    </>
  );
}

export function ActivityCodeFrequency() {
  return (
    <ActivityPage section="code-frequency">
      {(repoId) => (
        <Statistics repoId={repoId} skeleton={<ChartSkeleton/>}>
          {(s, branch) => {
            const weeks = yearAtLeast(s.total);
            const add = weeks.reduce((n, w) => n + w.additions, 0);
            const del = weeks.reduce((n, w) => n + w.deletions, 0);
            return (
              <DashboardSection label="Code frequency" title={<><span className="text-default">Additions and deletions per week</span><span className="font-mono">{branch}</span></>} padded>
                <DivergingChart label={`Lines added and deleted per week on ${branch}`}
                  columns={weeks.map((w) => ({label: weekLabel(w.week), up: w.additions, down: w.deletions}))}
                  caption={<><span className="text-success">{count(add)} {plural(add, 'addition')}</span>, <span className="text-danger">{count(del)} {plural(del, 'deletion')}</span> in all</>}
                  start={dateLabel(weeks[0]?.week)} end={dateLabel(weeks.at(-1)?.week)}/>
              </DashboardSection>
            );
          }}
        </Statistics>
      )}
    </ActivityPage>
  );
}

export function ActivityRecentCommits() {
  return (
    <ActivityPage section="recent-commits">
      {(repoId) => (
        <Statistics repoId={repoId} skeleton={<ChartSkeleton/>}>
          {(s, branch) => <RecentCommits stats={s} branch={branch}/>}
        </Statistics>
      )}
    </ActivityPage>
  );
}

function RecentCommits({stats, branch}: {stats: APIContributors; branch: string}) {
  const [now] = useState(() => Date.now());
  const weeks = lastWeeks(stats.total, 52, now);
  const commits = weeks.reduce((n, w) => n + w.commits, 0);
  return (
    <DashboardSection label="Recent commits" title={<><span className="text-default">Commits per week, the last year</span><span className="font-mono">{branch}</span></>} padded>
      <ColumnChart label={`Commits per week to ${branch} in the last 52 weeks`} size="lg" unit="commits"
        columns={weeks.map((w) => ({label: weekLabel(w.week), value: w.commits}))}
        caption={`${count(commits)} ${plural(commits, 'commit')} in the last 52 weeks`}
        start={dateLabel(weeks[0]?.week)} end={dateLabel(weekOf(now))}/>
    </DashboardSection>
  );
}
