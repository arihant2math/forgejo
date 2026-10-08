// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// One issue or pull request (/{owner}/{repo}/issues/{n}, /pulls/{n}): the
// summary from the repository's group renders at once — title, state,
// labels, people — and the lazy group issue:{id} (B6: body, timeline,
// reactions, dependencies) fills in from IndexedDB or the server while the
// page is open. Nothing waits on the network to show what the pool has.
// S/L/A/M/P edit it (the pickers); its own chunk.

import {useLocation, useNavigate, useParams} from '@tanstack/react-router';
import {CircleDot, SearchX} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {AvailableOffline} from '../../app/Available.tsx';
import {useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {type PickerKind, useApp, useSession} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {tempNum} from '../../intents/intents.ts';
import {editing} from '../../intents/session.ts';
import {EmptyState, Skeleton} from '../../ui/index.ts';
import {openPicker} from '../issues/actions.ts';
import {PendingCell, StateIcon, TitleCell, usePool, useUser} from '../issues/cells.tsx';
import {closedPager} from '../issues/closed.ts';
import {agoWords, fullDate} from '../issues/format.ts';
import {RepoContext, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {BodySection, CommentComposer, Overrides} from './Editing.tsx';
import {Reactions} from './Reactions.tsx';
import {IssueSidebar} from './Sidebar.tsx';
import {Timeline} from './Timeline.tsx';

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
  const pulls = useLocation({select: (l) => /\/pulls\/[^/]+\/?$/.test(l.pathname)});
  const context = <RepoContext owner={owner} repo={repo} pulls={pulls}/>;
  if (repoId === undefined) {
    return (
      <>
        <PageHeader context={context} title={`#${String(index)}`}/>
        <PageBody><Unavailable/></PageBody>
      </>
    );
  }
  return <IssuePage key={`${String(repoId)}#${String(index)}`} repoId={repoId} index={index} context={context}/>;
}

/** The path segment of an issue created offline (see `tempIssuePath`). */
const TEMP_PATH = /^new-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/;

/** The page of an issue created offline, before Forgejo numbers it ("…/issues/new-<tempId>"). */
export function tempIssuePath(owner: string, repo: string, tempId: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new-${tempId}`;
}

const IssuePage = observer(function IssuePage({repoId, index, context}: {repoId: number; index: number; context: ReactNode}) {
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
  if (!issue) return <NotHere repoId={repoId} index={index} context={context}/>;
  return (
    <>
      <PageHeader context={context} title={<IssueTitle issue={issue} index={index}/>}/>
      <PageBody ref={setScroller}>
        <IssueContent issue={issue} scroller={scroller}/>
      </PageBody>
    </>
  );
});

function IssueContent({issue, scroller}: {issue: Entity<'Issue'>; scroller: HTMLDivElement | null}) {
  const app = useApp();
  const {data} = useSession();
  useHold(data, `issue:${String(issue.id)}`);
  // The palette's issue actions and the shortcuts act on this issue.
  useEffect(() => {
    runInAction(() => {
      app.ui.issueTarget = [issue.id];
    });
    return () => {
      runInAction(() => {
        app.ui.issueTarget = [];
      });
    };
  }, [app, issue.id]);
  const pick = (kind: PickerKind) => () => {
    openPicker(app, kind, [issue.id]);
  };
  useShortcutScope('issue');
  useShortcut('issue.state', pick('status'));
  useShortcut('issue.labels', pick('labels'));
  useShortcut('issue.assignee', pick('assignees'));
  useShortcut('issue.milestone', pick('milestone'));
  useShortcut('issue.priority', pick('priority'));
  return (
    <div className="flex min-h-full">
      <article className="flex min-w-0 flex-1 flex-col gap-3 px-8 py-6">
        <h2 className="text-xl font-semibold text-fg"><TitleCell issue={issue}/></h2>
        <Byline issue={issue}/>
        <Overrides issueId={issue.id}/>
        <BodySection issue={issue}/>
        <Reactions issueId={issue.id} commentId={0}/>
        <div className="mt-4 border-t border-border-subtle pt-2">
          <Timeline issueId={issue.id} scroller={scroller}/>
          <CommentComposer issueId={issue.id} repoId={issue.get('repo_id')}/>
        </div>
      </article>
      <aside aria-label="Properties" className="w-pane shrink-0 border-l border-border">
        <div className="sticky top-0 p-4">
          <IssueSidebar issue={issue}/>
        </div>
      </aside>
    </div>
  );
}

/** The header's title: the state icon, the number and the title (the page's h1; the body repeats the title large). */
const IssueTitle = observer(function IssueTitle({issue, index}: {issue: Entity<'Issue'>; index: number}) {
  return (
    <>
      <span className="mr-2 inline-flex align-text-bottom"><StateIcon issue={issue}/></span>
      <span className="text-fg-subtle tabular-nums">{index > 0 ? `#${String(index)}` : 'New'}</span> <TitleCell issue={issue}/> <PendingCell issueId={issue.id}/>
    </>
  );
});

const Byline = observer(function Byline({issue}: {issue: Entity<'Issue'>}) {
  const author = useUser(issue.get('poster_id'));
  const at = issue.get('created_at');
  const name = issue.get('poster_id') ? author.name : issue.get('original_author') || 'Someone';
  return (
    <p className="text-base text-fg-muted">
      <span className="font-medium text-fg">{name}</span> opened this <time dateTime={at} title={fullDate(at)}>{agoWords(at)}</time>
      {issue.get('comments') > 0 && <> · {issue.get('comments')} {issue.get('comments') === 1 ? 'comment' : 'comments'}</>}
    </p>
  );
});

/** The issue is not in the pool: an older closed one loads with the closed tier's pages; otherwise it is not here. */
const NotHere = observer(function NotHere({repoId, index, context}: {repoId: number; index: number; context: ReactNode}) {
  const {data} = useSession();
  const pager = closedPager(data, `repo:${String(repoId)}`);
  useEffect(() => {
    if (!pager.done && !pager.loading) pager.more();
  }, [pager, pager.loading, pager.done]);
  // Offline nothing more can arrive: say so at once (no placeholder that never resolves).
  const offline = data.status.connection === 'offline' || !navigator.onLine;
  const searching = !offline && (!pager.done || data.status.loading > 0);
  return (
    <>
      <PageHeader icon={CircleDot} context={context} title={`#${String(index)}`}/>
      <PageBody>
        {searching ?
          <div className="flex flex-col gap-3 px-8 py-6" aria-busy><Skeleton className="h-5 w-96"/><Skeleton className="h-3 w-full"/><Skeleton className="h-3 w-2/3"/></div> :
          !offline ?
            <EmptyState icon={SearchX} title="Not found" description="This issue does not exist, or you cannot see it."/> :
            <EmptyState icon={SearchX} title="Not available offline" description="This issue is not on this device. Connect to load it, or open one of these:" action={<AvailableOffline/>}/>}
      </PageBody>
    </>
  );
});
