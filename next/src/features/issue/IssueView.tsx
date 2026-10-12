// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Render cached summaries immediately; the held issue group supplies conversation details.

import {createLink, useMatch, useNavigate, useParams, useRouter, useRouterState, useSearch} from '@tanstack/react-router';
import {openCreate} from '../../app/create.ts';
import {canWrite} from '../../app/access.ts';
import {issueLocked, issueTitle, issueState} from '../../intents/view.ts';
import {runInAction, untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {lazyComponent, whenIdle} from '../../app/lazy.tsx';
import {preloadEditor} from '../editor/Composer.tsx';
import {reach} from '../../app/online.ts';
import {isListPath} from '../../app/paths.ts';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import {notify} from '../../app/notices.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {tempNum} from '../../intents/intents.ts';
import {TEMP_PATH} from './paths.ts';
import {editing} from '../../intents/session.ts';
import {openPicker} from '../issues/actions.ts';
import {readThreadWhileOpen} from '../inbox/actions.ts';
import {isDraft, AssigneesCell, LabelsCell, PendingCell, PriorityCell, PullStateCell, StateIcon, StatusCell, TitleCell, useLabelView, usePool, UserAvatar, UserName} from '../issues/cells.tsx';
import {closedPager} from '../issues/closed.ts';
import {agoWords, fullDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {Missing} from '../../app/Missing.tsx';
import {CommentComposer, Overrides, TitleSection} from './Editing.tsx';
import {IssueSidebar} from './Sidebar.tsx';
import {DescriptionItem, Timeline} from './Timeline.tsx';
import type {PullTabName} from '../pull/Pull.tsx';
import {checksOf} from '../pull/checks.ts';
import {poolHead, pullOf} from '../../code/pull.ts';
import {wipPrefixes} from '../pull/draft.ts';
import {scopedValue, statusStage} from '../issues/labels.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {CheckIcon, CopyIcon, IssueOpenedIcon, LockIcon, SearchIcon} from '@primer/octicons-react';
import {BranchName, Button, IconButton, Label, StateLabel, UnderlineNav} from '@primer/react';
import {SkeletonBox, SkeletonText} from '@primer/react/experimental';

// Keep code surfaces out of the conversation chunk.
const PullTab = lazyComponent(() => import('../pull/Pull.tsx').then((m) => m.PullTab));
const MergeBox = lazyComponent(() => import('../pull/Pull.tsx').then((m) => m.MergeBox));

/** Observes only issues with this repository and number, not the whole repository. */
export function findIssue(pool: Pool, repoId: number, index: number): Entity<'Issue'> | undefined {
  for (const e of pool.model('Issue').by('number', index)) if (e.get('repo_id') === repoId) return e;
  return undefined;
}

function indexLabel(index: number): string {
  return index < 0 ? 'New' : `#${String(index)}`;
}

export function IssueView() {
  const {owner, repo, repoId} = useRepoPage();
  const {index: raw = ''} = useParams({strict: false});
  const app = useApp();
  const navigate = useNavigate();
  useEffect(() => {
    if (raw !== 'new' || repoId === undefined) return;
    openCreate(app, repoId);
    void navigate({to: '/$owner/$repo/issues', params: {owner, repo}, replace: true});
  }, [app, raw, repoId, owner, repo, navigate]);
  const temp = TEMP_PATH.exec(raw)?.[1];
  const index = temp ? tempNum(temp) : /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : 0;
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} title={indexLabel(index)}/>
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
  const real = index < 0 ? intents.remapped.get(index) : undefined;
  const created = real === undefined ? undefined : pool.model('Issue').get(real);
  const number = created?.get('number');
  useEffect(() => {
    if (number) void navigate({to: '/$owner/$repo/issues/$index', params: {owner, repo, index: String(number)}, replace: true});
  }, [navigate, number, owner, repo]);
  const issue = index < 0 ? created ?? overlay.createdEntity('Issue', index) as Entity<'Issue'> | undefined : findIssue(pool, repoId, index);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const tab = useSearch({strict: false, select: (s: {tab?: PullTabName}) => s.tab});
  // Use this page's route match: the live location can belong to the next page while this one is mounted.
  const self = useMatch({strict: false, shouldThrow: false, select: (m) => `${m.routeId}\n${m.pathname}`});
  const [routeId = '', matchPath = ''] = self?.split('\n') ?? [];
  const onPulls = routeId.endsWith('/pulls/$index');
  const settled = useRouterState({select: (s) => s.location.pathname === matchPath && s.resolvedLocation?.pathname === matchPath});
  const isPull = issue?.get('is_pull');
  useEffect(() => {
    if (isPull === undefined || index <= 0 || !routeId || !settled || isPull === onPulls) return;
    void navigate({to: isPull ? '/$owner/$repo/pulls/$index' : '/$owner/$repo/issues/$index', params: {owner, repo, index: String(index)}, hash: true, replace: true});
  }, [isPull, onPulls, routeId, settled, index, navigate, owner, repo]);
  // Viewing any pull tab reads the issue's notifications.
  const issueId = issue?.id;
  useEffect(() => (issueId === undefined ? undefined : readThreadWhileOpen(app, issueId)), [app, issueId]);
  if (!issue) return <NotHere owner={owner} repo={repo} repoId={repoId} index={index}/>;
  const pull = issue.get('is_pull') && index > 0;
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} title={<IssueTitle issue={issue} index={index}/>} detail={pull ? 'pulls' : 'issues'}
        docTitle={`${issueTitle(editing(app).overlay, issue)} · ${indexLabel(index)}`}/>
      {pull && <PullTabs issue={issue} owner={owner} repo={repo} index={String(index)} tab={tab}/>}
      <PageBody ref={setScroller} bounded={!(pull && tab)}>
        {pull && tab ? <PullTab issue={issue} owner={owner} repo={repo} tab={tab}/> : <IssueContent issue={issue} scroller={scroller}/>}
      </PageBody>
    </>
  );
});

const PullTabLink = createLink(UnderlineNav.Item);

const PULL_TABS: [PullTabName | undefined, string][] = [[undefined, 'Conversation'], ['commits', 'Commits'], ['checks', 'Checks'], ['files', 'Files changed']];

/** Counters come from what the pool knows (0 included, as on GitHub); a count that needs the diff is left out. */
const PullTabs = observer(function PullTabs({issue, owner, repo, index, tab}: {issue: Entity<'Issue'>; owner: string; repo: string; index: string; tab: PullTabName | undefined}) {
  const pool = usePool();
  const pr = pullOf(pool, issue.id);
  const head = pr ? poolHead(pool, pr) : undefined;
  const checks = pr && head ? checksOf(pool, pr, head) : undefined;
  const counters: Partial<Record<string, number>> = {
    Conversation: issue.get('comments'),
    Commits: pr?.commits_ahead,
    Checks: checks ? checks.statuses.length + checks.runs.length : undefined,
  };
  return (
    <UnderlineNav aria-label="Pull request">
      {PULL_TABS.map(([t, label]) => {
        const n = counters[label];
        return (
          <PullTabLink key={label} to="/$owner/$repo/pulls/$index" params={{owner, repo, index}} search={t ? {tab: t} : {}} aria-current={t === tab ? 'page' : false}
            {...n === undefined ? {} : {counter: n}} activeProps={{}} activeOptions={{includeSearch: true, exact: true}} onPointerEnter={() => {
              void PullTab.preload().catch(() => undefined);
            }}>{label}</PullTabLink>
        );
      })}
    </UnderlineNav>
  );
});

function IssueContent({issue, scroller}: {issue: Entity<'Issue'>; scroller: HTMLDivElement | null}) {
  const app = useApp();
  const {data} = useSession();
  useHold(data, `issue:${String(issue.id)}`);
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
  // Prefetch the editor chunk before the reader reaches the comment box.
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
    <div className="flex min-h-full flex-col @xl:flex-row">
      <article className="conversation-markdown flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 @xl:px-8 @xl:py-6">
        <header className="flex flex-col gap-2 border-b border-default pb-4">
          <TitleSection issue={issue}/>
          <Byline issue={issue}/>
        </header>
        <PropertiesSummary issue={issue}/>
        <Overrides issueId={issue.id}/>
        {/* The conversation's gutter holds the avatars where the column is wide enough. */}
        <div className="@container/conversation">
          <div className="flex flex-col @md/conversation:pl-14">
            <DescriptionItem issue={issue}/>
            <Timeline issueId={issue.id} scroller={scroller}/>
            {issue.get('is_pull') && issue.id > 0 && <MergeBox issue={issue}/>}
            <Composer issue={issue}/>
          </div>
        </div>
      </article>
      {/* Bound the sticky sidebar to the page body so it scrolls independently of the conversation. */}
      <aside id={PROPERTIES} tabIndex={-1} aria-label="Properties" className="shrink-0 border-t border-default outline-none @xl:w-pane @xl:border-t-0 @xl:border-l">
        <div className="p-4 @xl:sticky @xl:top-0 @xl:max-h-page-body @xl:overflow-y-auto @xl:overscroll-contain">
          <IssueSidebar issue={issue}/>
        </div>
      </aside>
    </div>
  );
}

/** Locked conversations accept comments only from repository writers. */
const Composer = observer(function Composer({issue}: {issue: Entity<'Issue'>}) {
  const session = useSession();
  const locked = issueLocked(editing(useApp()).overlay, issue);
  const note = (text: string) => <p className="flex items-center gap-2 pt-3 text-base text-muted"><LockIcon size={12} className="shrink-0"/>{text}</p>;
  if (locked && !canWrite(session, issue.get('repo_id'))) return note('This conversation is locked: only collaborators can comment.');
  return (
    <div className="relative mt-2">
      <span className="absolute top-3 -left-14 hidden @md/conversation:block"><UserAvatar id={session.userId} size="lg" linked/></span>
      {locked && note('This conversation is locked: only collaborators, like you, can comment.')}
      <CommentComposer issueId={issue.id} repoId={issue.get('repo_id')}/>
    </div>
  );
});

const IssueTitle = observer(function IssueTitle({issue, index}: {issue: Entity<'Issue'>; index: number}) {
  return (
    <>
      <span className="mr-2 inline-flex align-text-bottom"><StateIcon issue={issue}/></span>
      <span className="text-muted tabular-nums">{indexLabel(index)}</span> <TitleCell issue={issue}/> <PendingCell issueId={issue.id}/>
      <span className="ml-2 inline-flex items-center gap-1 align-middle"><PullStateCell issue={issue}/></span>
    </>
  );
});

const PROPERTIES = 'issue-properties';

const PropertiesSummary = observer(function PropertiesSummary({issue}: {issue: Entity<'Issue'>}) {
  return (
    <div className="flex flex-wrap items-center gap-2 @xl:hidden">
      <StatusCell issue={issue}/><PriorityCell issue={issue}/><LabelsCell issue={issue}/><AssigneesCell issue={issue}/>
      <Button variant="invisible" size="small" type="button" onClick={() => {
        const pane = document.getElementById(PROPERTIES);
        pane?.scrollIntoView({block: 'start'});
        pane?.focus({preventScroll: true});
      }}>All properties</Button>
    </div>
  );
});

/** GitHub's state label and byline; a pull request's names its branches, as GitHub does. */
export const Byline = observer(function Byline({issue}: {issue: Entity<'Issue'>}) {
  const app = useApp();
  const pool = usePool();
  const {overlay} = editing(app);
  const state = issueState(overlay, issue);
  const pr = issue.get('is_pull') ? pullOf(pool, issue.id) : undefined;
  const {status} = useLabelView(issue);
  const open = state === 'open';
  const [look, label] = pr?.merged ? ['pullMerged', 'Merged'] as const :
    pr && open && isDraft(issueTitle(overlay, issue), wipPrefixes(app.config)) ? ['draft', 'Draft'] as const :
    issue.get('is_pull') ? open ? ['pullOpened', 'Open'] as const : ['pullClosed', 'Closed'] as const :
    open ? ['issueOpened', 'Open'] as const :
    status && statusStage(scopedValue(status.name)) === 'canceled' ? ['issueClosedNotPlanned', 'Closed'] as const : ['issueClosed', 'Closed'] as const;
  const at = issue.get('created_at');
  const comments = issue.get('comments');
  const author = <UserName id={issue.get('poster_id')} fallback={issue.get('original_author') || 'Someone'}/>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StateLabel status={look}>{label}</StateLabel>
      <p className="min-w-0 text-base text-muted">
        {pr ? <PullByline pr={pr} author={author}/> : <>{author} opened this {issue.get('is_pull') ? 'pull request' : 'issue'} <time dateTime={at} title={fullDate(at)}>{agoWords(at)}</time></>}
        {comments > 0 && <> · {comments} {comments === 1 ? 'comment' : 'comments'}</>}
      </p>
    </div>
  );
});

/** How long the copy button shows its check after copying. */
const COPIED_MS = 2000;

const PullByline = observer(function PullByline({pr, author}: {pr: PullRequest; author: ReactNode}) {
  const app = useApp();
  const pool = usePool();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => { setCopied(false); }, COPIED_MS);
    return () => { clearTimeout(timer); };
  }, [copied]);
  const fork = pr.head_repo_id !== pr.base_repo_id;
  const headOwner = fork ? pool.model('Repository').get(pr.head_repo_id)?.get('owner_name') : undefined;
  const head = headOwner ? `${headOwner}:${pr.head_branch}` : pr.head_branch;
  // Infer deletion only when the head repository's branches are cached; a fork's may be absent.
  const branches = [...pool.model('Branch').by('repo_id', pr.head_repo_id)].map((b) => b.data);
  const known = branches.find((b) => b.name === pr.head_branch);
  const deleted = branches.length > 0 && (known === undefined || known.is_deleted);
  const commits = pr.commits_ahead > 0 ? `${String(pr.commits_ahead)} ${pr.commits_ahead === 1 ? 'commit' : 'commits'} ` : '';
  return (
    <>
      {pr.merged ? <><UserName id={pr.merger_id}/> merged {commits}into</> : <>{author} wants to merge {commits}into</>}{' '}
      <BranchName as="span">{pr.base_branch}</BranchName> from <BranchName as="span">{head}</BranchName>
      <span className="inline-flex align-middle"><IconButton icon={copied ? CheckIcon : CopyIcon} variant="invisible" size="small"
        aria-label={copied ? 'Copied!' : 'Copy head branch name'} onClick={() => {
          navigator.clipboard.writeText(pr.head_branch).then(() => { setCopied(true); }, () => notify(app, {tone: 'warning', title: 'Could not copy the branch name'}));
        }}/></span>
      {fork && <Label>Fork</Label>}{deleted && <> <Label>Deleted</Label></>}
      {pr.merged && pr.merged_at && <> <time dateTime={pr.merged_at} title={fullDate(pr.merged_at)}>{agoWords(pr.merged_at)}</time></>}
    </>
  );
});

/** Missing closed issues may still arrive through the repository's closed-tier pager. */
const NotHere = observer(function NotHere({owner, repo, repoId, index}: {owner: string; repo: string; repoId: number; index: number}) {
  const {data} = useSession();
  const pager = closedPager(data, `repo:${String(repoId)}`);
  useEffect(() => {
    if (!pager.done && !pager.loading) pager.more();
  }, [pager, pager.loading, pager.done]);
  const offline = reach(data.status.connection) !== 'online';
  const searching = !offline && (!pager.done || data.status.loading > 0);
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={IssueOpenedIcon} title={indexLabel(index)} detail="issues"/>
      <PageBody>
        {searching ?
          <div className="flex flex-col gap-4 px-8 py-6" aria-busy><SkeletonBox className="h-5 w-96"/><SkeletonText lines={2}/></div> :
          <Missing what="This issue" icon={SearchIcon} description={index < 0 ?
            'This address belongs to an issue created offline on another device. Find it in the repository’s issues.' :
            undefined}/>}
      </PageBody>
    </>
  );
});
