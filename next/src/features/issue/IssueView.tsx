// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One issue or pull request (/{owner}/{repo}/issues/{n}, /pulls/{n}): the
// summary from the repository's group renders at once — title, state,
// labels, people — and the lazy group issue:{id} (B6: body, timeline,
// reactions, dependencies) fills in from IndexedDB or the server while the
// page is open. Nothing waits on the network to show what the pool has.
// S/L/A/M/P edit it (the pickers); its own chunk.

import {Link, useMatch, useNavigate, useParams, useRouter, useRouterState, useSearch} from '@tanstack/react-router';
import {CircleDot, Lock, SearchX} from 'lucide-react';
import {canWrite} from '../../app/access.ts';
import {issueLocked, issueTitle} from '../../intents/view.ts';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {lazyComponent, whenIdle} from '../../app/lazy.tsx';
import {preloadEditor} from '../editor/Composer.tsx';
import {reach} from '../../app/online.ts';
import {isListPath} from '../../app/paths.ts';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {tempNum} from '../../intents/intents.ts';
import {TEMP_PATH} from './paths.ts';
import {editing} from '../../intents/session.ts';
import {Button, Icon, Skeleton, SkeletonText, TabLink, TabNav} from '../../ui/index.ts';
import {openPicker} from '../issues/actions.ts';
import {AssigneesCell, LabelsCell, PendingCell, PriorityCell, StateIcon, StatusCell, TitleCell, usePool, UserName} from '../issues/cells.tsx';
import {closedPager} from '../issues/closed.ts';
import {agoWords, fullDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {Missing} from '../../app/Missing.tsx';
import {BodySection, CommentComposer, Overrides, TitleSection} from './Editing.tsx';
import {Reactions} from './Reactions.tsx';
import {IssueSidebar} from './Sidebar.tsx';
import {Timeline} from './Timeline.tsx';

// A pull request's code views (Files, Commits, Checks) and its merge box: their own chunk (code surfaces, F7).
const PullTab = lazyComponent(() => import('../pull/Pull.tsx').then((m) => m.PullTab));
const MergeBox = lazyComponent(() => import('../pull/Pull.tsx').then((m) => m.MergeBox));

type PullTabName = 'files' | 'commits' | 'checks';

/** The issue of a repository by number (observes the issues numbered so, not every issue of the repository). */
export function findIssue(pool: Pool, repoId: number, index: number): Entity<'Issue'> | undefined {
  for (const e of pool.model('Issue').by('number', index)) if (e.get('repo_id') === repoId) return e;
  return undefined;
}

export function IssueView() {
  const {owner, repo, repoId} = useRepoPage();
  const {index: raw = ''} = useParams({strict: false});
  // An issue created offline is at "new-<tempId>" until Forgejo numbers it (then the URL is replaced).
  const temp = TEMP_PATH.exec(raw)?.[1];
  const index = temp ? tempNum(temp) : /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : 0;
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} title={`#${String(index)}`}/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <IssuePage key={`${String(repoId)}#${String(index)}`} repoId={repoId} index={index}/>;
}

const IssuePage = observer(function IssuePage({repoId, index}: {repoId: number; index: number}) {
  const pool = usePool();
  const app = useApp();
  const {overlay, intents} = editing(app);
  const navigate = useNavigate();
  const {owner = '', repo = ''} = useParams({strict: false});
  // index < 0: created offline. Once created, the server's issue replaces it, in the URL too (router.replace).
  const real = index < 0 ? intents.remapped.get(index) : undefined;
  const created = real === undefined ? undefined : pool.model('Issue').get(real);
  const number = created?.get('number');
  useEffect(() => {
    if (number) void navigate({to: '/$owner/$repo/issues/$index', params: {owner, repo, index: String(number)}, replace: true});
  }, [navigate, number, owner, repo]);
  const issue = index < 0 ? created ?? overlay.createdEntity('Issue', index) as Entity<'Issue'> | undefined : findIssue(pool, repoId, index);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const tab = useSearch({strict: false, select: (s: {tab?: PullTabName}) => s.tab});
  // /pulls/{n} of an issue and /issues/{n} of a pull request: the canonical address (classic redirects too). The
  // kind is this page's own route match, never the live location: while the user navigates away this page is still
  // mounted and the location already names the next page, which must not be taken for a wrong kind (QA round 2: a
  // pull request "replaced" every navigation away from it with itself).
  const self = useMatch({strict: false, shouldThrow: false, select: (m) => `${m.routeId}\n${m.pathname}`});
  const [routeId = '', matchPath = ''] = self?.split('\n') ?? [];
  const onPulls = routeId.endsWith('/pulls/$index');
  // Only while this page is the one on screen and no navigation is under way.
  const settled = useRouterState({select: (s) => s.location.pathname === matchPath && s.resolvedLocation?.pathname === matchPath});
  const isPull = issue?.get('is_pull');
  useEffect(() => {
    if (isPull === undefined || index <= 0 || !routeId || !settled || isPull === onPulls) return;
    void navigate({to: isPull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index', params: {owner, repo, index: String(index)}, replace: true});
  }, [isPull, onPulls, routeId, settled, index, navigate, owner, repo]);
  if (!issue) return <NotHere owner={owner} repo={repo} repoId={repoId} index={index}/>;
  const pull = issue.get('is_pull') && index > 0;
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} title={<IssueTitle issue={issue} index={index}/>} detail={pull ? 'pulls' : 'issues'}
        docTitle={`${issueTitle(editing(app).overlay, issue)} · ${index > 0 ? `#${String(index)}` : 'New'}`}/>
      {pull && <PullTabs owner={owner} repo={repo} index={String(index)} tab={tab}/>}
      <PageBody ref={setScroller}>
        {pull && tab ? <PullTab issue={issue} owner={owner} repo={repo} tab={tab}/> : <IssueContent issue={issue} scroller={scroller}/>}
      </PageBody>
    </>
  );
});

const PULL_TABS: [PullTabName | undefined, string][] = [[undefined, 'Conversation'], ['files', 'Files'], ['commits', 'Commits'], ['checks', 'Checks']];

/** Conversation (the issue page), and the pull request's code views. */
function PullTabs({owner, repo, index, tab}: {owner: string; repo: string; index: string; tab: PullTabName | undefined}) {
  return (
    <TabNav label="Pull request">
      {PULL_TABS.map(([t, label]) => (
        <TabLink key={label}>
          <Link to="/$owner/$repo/pulls/$index" params={{owner, repo, index}} search={t ? {tab: t} : {}} aria-current={t === tab ? 'page' : undefined}
            activeProps={{}} activeOptions={{includeSearch: true, exact: true}} onPointerEnter={() => {
              void PullTab.preload().catch(() => undefined);
            }}>{label}</Link>
        </TabLink>
      ))}
    </TabNav>
  );
}

function IssueContent({issue, scroller}: {issue: Entity<'Issue'>; scroller: HTMLDivElement | null}) {
  const app = useApp();
  const {data} = useSession();
  useHold(data, `issue:${String(issue.id)}`);
  // The palette's issue actions and the shortcuts act on this issue.
  useEffect(() => {
    runInAction(() => {
      app.ui.issueTarget = [issue.id];
      app.ui.issueOpen = issue.id;
    });
    return () => {
      runInAction(() => {
        app.ui.issueTarget = [];
        if (app.ui.issueOpen === issue.id) app.ui.issueOpen = undefined;
      });
    };
  }, [app, issue.id]);
  const pick = (kind: PickerKind) => () => {
    openPicker(app, kind, [issue.id]);
  };
  // The comment box's editor (CodeMirror, its own chunk) is usually wanted next.
  useEffect(() => {
    whenIdle(() => {
      void preloadEditor().catch(() => undefined);
    });
  }, []);
  useShortcutScope('issue');
  useShortcut('issue.state', pick('status'));
  useShortcut('issue.labels', pick('labels'));
  useShortcut('issue.assignee', pick('assignees'));
  useShortcut('issue.milestone', pick('milestone'));
  useShortcut('issue.priority', pick('priority'));
  // Esc: back to the list the issue was opened from (with its filters and scroll), else — opened from Home, the
  // palette, a link — its repository's list.
  const router = useRouter();
  useShortcut('issue.back', () => {
    const from = untracked(() => app.ui.previousPath);
    if (from && isListPath(from) && router.history.canGoBack()) router.history.back();
    else {
      const r = untracked(() => app.session?.data.pool.model('Repository').get(issue.data.repo_id)?.data);
      if (r) void router.navigate({to: issue.data.is_pull ? '/$owner/$repo/pulls' : '/$owner/$repo/issues', params: {owner: r.owner_name, repo: r.name}});
    }
  });
  return (
    // The properties beside the conversation when the page is wide, after it when it is not (a phone, a narrow
    // window: the title and the description come first).
    <div className="flex min-h-full flex-col @xl:flex-row">
      <article className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 @xl:px-8 @xl:py-6">
        <TitleSection issue={issue}/>
        <Byline issue={issue}/>
        <PropertiesSummary issue={issue}/>
        <Overrides issueId={issue.id}/>
        <BodySection issue={issue}/>
        <Reactions issueId={issue.id} commentId={0}/>
        <div className="mt-4 border-t border-border-subtle pt-2">
          <Timeline issueId={issue.id} scroller={scroller}/>
          {issue.get('is_pull') && issue.id > 0 && <MergeBox issue={issue}/>}
          <Composer issue={issue}/>
        </div>
      </article>
      <aside id={PROPERTIES} tabIndex={-1} aria-label="Properties" className="shrink-0 border-t border-border outline-none @xl:w-pane @xl:border-t-0 @xl:border-l">
        <div className="p-4 @xl:sticky @xl:top-0">
          <IssueSidebar issue={issue}/>
        </div>
      </aside>
    </div>
  );
}

/** The comment box; a locked conversation takes comments from writers only (Forgejo's rule). */
const Composer = observer(function Composer({issue}: {issue: Entity<'Issue'>}) {
  const session = useSession();
  const locked = issueLocked(editing(useApp()).overlay, issue);
  const note = (text: string) => <p className="flex items-center gap-2 pt-3 text-base text-fg-muted"><Icon icon={Lock} size="sm"/>{text}</p>;
  if (locked && !canWrite(session, issue.get('repo_id'))) return note('This conversation is locked: only collaborators can comment.');
  return (
    <>
      {locked && note('This conversation is locked: only collaborators, like you, can comment.')}
      <CommentComposer issueId={issue.id} repoId={issue.get('repo_id')}/>
    </>
  );
});

/** The header's title: the state icon, the number and the title (the page's h1; the body repeats the title large). */
const IssueTitle = observer(function IssueTitle({issue, index}: {issue: Entity<'Issue'>; index: number}) {
  return (
    <>
      <span className="mr-2 inline-flex align-text-bottom"><StateIcon issue={issue}/></span>
      <span className="text-fg-subtle tabular-nums">{index > 0 ? `#${String(index)}` : 'New'}</span> <TitleCell issue={issue}/> <PendingCell issueId={issue.id}/>
    </>
  );
});

const PROPERTIES = 'issue-properties';

/**
 * On a narrow page (a phone) the properties come after the whole conversation: their gist sits under the title,
 * with a way to them (on a wide page they are beside it, and this row is not shown).
 */
const PropertiesSummary = observer(function PropertiesSummary({issue}: {issue: Entity<'Issue'>}) {
  return (
    <div className="flex flex-wrap items-center gap-2 @xl:hidden">
      <StatusCell issue={issue}/><PriorityCell issue={issue}/><LabelsCell issue={issue}/><AssigneesCell issue={issue}/>
      <Button size="sm" variant="ghost" onClick={() => {
        const pane = document.getElementById(PROPERTIES);
        pane?.scrollIntoView({block: 'start'});
        pane?.focus({preventScroll: true});
      }}>All properties</Button>
    </div>
  );
});

const Byline = observer(function Byline({issue}: {issue: Entity<'Issue'>}) {

  const at = issue.get('created_at');

  return (
    <p className="text-base text-fg-muted">
      <UserName id={issue.get('poster_id')} fallback={issue.get('original_author') || 'Someone'}/> opened this <time dateTime={at} title={fullDate(at)}>{agoWords(at)}</time>
      {issue.get('comments') > 0 && <> · {issue.get('comments')} {issue.get('comments') === 1 ? 'comment' : 'comments'}</>}
    </p>
  );
});

/** The issue is not in the pool: an older closed one loads with the closed tier's pages; otherwise it is not here. */
const NotHere = observer(function NotHere({owner, repo, repoId, index}: {owner: string; repo: string; repoId: number; index: number}) {
  const {data} = useSession();
  const pager = closedPager(data, `repo:${String(repoId)}`);
  useEffect(() => {
    if (!pager.done && !pager.loading) pager.more();
  }, [pager, pager.loading, pager.done]);
  // Offline nothing more can arrive: say so at once (no placeholder that never resolves).
  const offline = reach(data.status.connection) !== 'online';
  const searching = !offline && (!pager.done || data.status.loading > 0);
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={CircleDot} title={`#${String(index)}`} detail="issues"/>
      <PageBody>
        {searching ?
          <div className="flex flex-col gap-3 px-8 py-6" aria-busy><Skeleton className="h-5 w-96"/><SkeletonText lines={2}/></div> :
          // Every page of the repository's issues has been asked: Forgejo has no such issue the viewer can see, and
          // its classic page would say the same (no classic link to a 404).
          <Missing what="This issue" icon={SearchX} title="Not found"/>}
      </PageBody>
    </>
  );
});
