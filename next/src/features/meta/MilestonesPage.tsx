// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's milestones (/{owner}/{repo}/milestones), as GitHub lays
// them out: open and closed tabs; each milestone's title, due date (overdue
// in the danger tone), the start of its description, its progress (closed
// of all its issues and pull requests) and counts that open its page.
// Computed from the pool (counts.ts), so it paints at once and works
// offline; writers close, reopen, edit and delete (online: writes.ts).

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {MilestoneSort} from '../../app/search.ts';
import {PageBody, PageColumn, viewChange} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {cx, Panel, PendingIcon, Skeleton} from '../../ui/index.ts';
import {ago, fullDate} from '../issues/format.ts';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import {PageSearch, SortMenu} from './controls.tsx';
import {IssueNav} from './IssueNav.tsx';
import {DeleteMilestoneDialog, DueLine} from './MilestoneActions.tsx';
import {excerpt, listMilestones, MILESTONE_SORT_NAMES, type MilestoneRow, milestoneRows, overdue} from './milestones.ts';
import {useRepoCounts} from './repoCounts.ts';
import {editMilestone, isPending, type RepoRef, viewMilestones} from './writes.ts';
import {CheckCircleIcon, IssueOpenedIcon, MilestoneIcon, PencilIcon, UndoIcon, TrashIcon} from '@primer/octicons-react';
import {Button, Label, ProgressBar} from '@primer/react';
import {OptionalTooltip} from '../../app/OptionalTooltip.tsx';
import {RouterLinkButton, RouterLink} from '../../app/RouterLinkButton.tsx';
import {Blankslate, SkeletonBox} from '@primer/react/experimental';

const milestonesApi = getRouteApi('/shell/$owner/$repo/milestones');

/** A milestone's entry in the list (and its skeleton's). */
const ENTRY = 'flex flex-col gap-2 border-b border-border-subtle px-3 py-3 last:border-b-0';

export function MilestonesPage() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={MilestoneIcon} title="Milestones"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <MilestonesView key={repoId} r={{owner, repo, repoId}}/>;
}

const MilestonesView = observer(function MilestonesView({r}: {r: RepoRef}) {
  const {owner, repo, repoId} = r;
  const s = useSession();
  const search = milestonesApi.useSearch();
  const navigate = useNavigate();
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const q = typed ?? search.q ?? '';
  const sort: MilestoneSort = search.sort ?? 'closestduedate';
  const write = useCanWrite(repoId);
  const counts = useRepoCounts(repoId).get().milestones;
  const [deleting, setDeleting] = useState<Milestone | undefined>(undefined);
  const all = milestoneRows(viewMilestones([...s.data.pool.model('Milestone').by('repo_id', repoId)].map((e) => e.data), repoId), counts);
  const state = search.state ?? 'open';
  const shown = listMilestones(all, {...search, q});
  const open = all.filter((m) => m.milestone.state !== 'closed').length;
  const closed = all.length - open;
  const go = (next: {state?: 'closed' | undefined; q?: string | undefined; sort?: MilestoneSort | undefined}) => {
    const m = {...search, ...next};
    void navigate({to: '.', replace: true, ...viewChange(), search: {
      ...(m.state ? {state: m.state} : {}), ...(m.q ? {q: m.q} : {}), ...(m.sort && m.sort !== 'closestduedate' ? {sort: m.sort} : {}),
    } as never});
  };
  const offline = !connectivity.online;
  const loading = s.data.status.loading > 0 && all.length === 0;
  const create = write && (
    <OptionalTooltip text={offline ? onlineOnly('Creating a milestone') : undefined}><RouterLinkButton variant="primary" size="small" leadingVisual={MilestoneIcon} to="/$owner/$repo/milestones/new" params={{owner, repo}}>New milestone</RouterLinkButton></OptionalTooltip>
  );
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={MilestoneIcon} title="Milestones">
        <IssueNav owner={owner} repo={repo} repoId={repoId} current="milestones"/>
        <PageSearch label="Search milestones" value={search.q ?? ''} onChange={setTyped} onSettle={(text) => {
          setTyped(undefined);
          go({q: text.trim() || undefined});
        }}/>
        <SortMenu value={sort} names={MILESTONE_SORT_NAMES} onChange={(v) => {
          go({sort: v});
        }}/>
        {create}
      </RepoHeader>
      <PageBody>
        <PageColumn wide>
          <Panel label="Milestones" title={
            <span className="flex items-center gap-1">
              <Button aria-pressed={state === 'open'} variant={state === 'open' ? 'default' : 'invisible'} size="small" leadingVisual={IssueOpenedIcon} type="button" onClick={() => {
                go({state: undefined});
              }}><span className="tabular-nums">{open}</span> Open</Button>
              <Button aria-pressed={state === 'closed'} variant={state === 'closed' ? 'default' : 'invisible'} size="small" leadingVisual={CheckCircleIcon} type="button" onClick={() => {
                go({state: 'closed'});
              }}><span className="tabular-nums">{closed}</span> Closed</Button>
            </span>
          }>
            {loading ? <MilestonesSkeleton/> : (
              <ul className="flex flex-col">
                {shown.map((row) => <MilestoneEntry key={row.milestone.id} r={r} row={row} write={write} onDelete={() => {
                  setDeleting(row.milestone);
                }}/>)}
              </ul>
            )}
            {!loading && shown.length === 0 && (q.trim() ?
              <Blankslate><Blankslate.Heading>No milestone matches</Blankslate.Heading><Blankslate.Description>No milestone here has these words in its title or description.</Blankslate.Description></Blankslate> :
              state === 'closed' ?
                <Blankslate><Blankslate.Visual><CheckCircleIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No closed milestones</Blankslate.Heading><Blankslate.Description>Milestones closed when their work is done are listed here.</Blankslate.Description></Blankslate> :
                <Blankslate><Blankslate.Visual><MilestoneIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No open milestones</Blankslate.Heading><Blankslate.Description>Milestones group issues and pull requests towards a release or a date.</Blankslate.Description>{create}</Blankslate>)}
          </Panel>
        </PageColumn>
      </PageBody>
      {deleting && <DeleteMilestoneDialog repo={r} milestone={deleting} onClose={() => {
        setDeleting(undefined);
      }}/>}
    </>
  );
});

/** One milestone: title (its page), due date, the start of its description; progress and counts; writers' actions. */
const MilestoneEntry = observer(function MilestoneEntry({r, row, write, onDelete}: {r: RepoRef; row: MilestoneRow; write: boolean; onDelete: () => void}) {
  const app = useApp();
  const {owner, repo} = r;
  const {milestone: m, progress: p} = row;
  const offline = !connectivity.online;
  const temp = m.id < 0;
  const params = {owner, repo, index: String(m.id)};
  const late = overdue(m);
  return (
    <li className={cx(ENTRY, '@xl:flex-row @xl:gap-6')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="flex min-w-0 items-center gap-2 text-md font-semibold">
          {temp ? <span className="truncate text-fg">{m.title}</span> :
            <RouterLink to="/$owner/$repo/milestone/$index" params={params} muted className="min-w-0 truncate">{m.title}</RouterLink>}
          {isPending('Milestone', m.id) && <PendingIcon label="Saving to Forgejo"/>}
          {late && <Label variant="danger">Overdue</Label>}
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <DueLine m={m}/>
          <span className="text-fg-subtle">Updated <time dateTime={m.updated_at} title={fullDate(m.updated_at)}>{ago(m.updated_at)}</time></span>
        </div>
        {m.description && <p className="truncate text-base text-fg-muted">{excerpt(m.description)}</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-2 @xl:w-80">
        <ProgressBar barSize="small" progress={p.total > 0 ? Math.min(100, Math.max(0, (p.closed) / (p.total) * 100)) : 0} aria-label={`${String(p.closed)} of ${String(p.total)} closed`}/>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted tabular-nums">
          <span className="font-semibold text-fg">{p.percent}% complete</span>
          {temp ? <span>{p.open} open</span> : <RouterLink to="/$owner/$repo/milestone/$index" params={params} muted className="min-w-0 truncate">{p.open}open</RouterLink>}
          {temp ? <span>{p.closed} closed</span> : <RouterLink to="/$owner/$repo/milestone/$index" params={params} search={{state: 'closed'}} muted className="min-w-0 truncate">{p.closed}closed</RouterLink>}
        </div>
        {write && !temp && (
          <div className="flex flex-wrap items-center gap-1">
            <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} to="/$owner/$repo/milestone/$index/edit" params={params}>Edit</RouterLinkButton>
            <OptionalTooltip text={offline ? onlineOnly(m.state === 'closed' ? 'Reopening a milestone' : 'Closing a milestone') : undefined}><Button variant="invisible" size="small" leadingVisual={m.state === 'closed' ? UndoIcon : CheckCircleIcon} type="button" disabled={offline} onClick={() => {
                const closing = m.state !== 'closed';
                void editMilestone(app, r, m, {state: closing ? 'closed' : 'open'}, `${closing ? 'Closing' : 'Reopening'} the milestone “${m.title}”`);
              }}>{m.state === 'closed' ? 'Reopen' : 'Close'}</Button></OptionalTooltip>
            <OptionalTooltip text={offline ? onlineOnly('Deleting a milestone') : undefined}><Button variant="invisible" size="small" leadingVisual={TrashIcon} type="button" disabled={offline} onClick={onDelete}>Delete</Button></OptionalTooltip>
          </div>
        )}
      </div>
    </li>
  );
});

/** The rows' shape while the repository's milestones load for the first time. */
function MilestonesSkeleton() {
  return (
    <ul role="presentation" className="flex flex-col">
      {['w-40', 'w-56', 'w-32'].map((w) => (
        <li key={w} className={ENTRY}>
          <Skeleton className={`h-4 ${w}`}/>
          <SkeletonBox className="h-3 w-24"/>
          <Skeleton round="full" className="h-2 w-full"/>
        </li>
      ))}
    </ul>
  );
}
