// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {clsx} from 'clsx';
import {Link, getRouteApi, useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {MilestoneSort} from '../../app/search.ts';
import {PageBody, PageColumn, viewChange} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {MetadataSection, SavingIndicator} from './LabelList.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import {SortMenu} from './controls.tsx';
import {SearchField} from '../issues/SearchField.tsx';
import {useShortcutScope} from '../../app/shortcuts/index.ts';
import {IssueNav} from './IssueNav.tsx';
import {DeleteMilestoneDialog, DueLine} from './MilestoneActions.tsx';
import {excerpt, listMilestones, MILESTONE_SORT_NAMES, type MilestoneRow, milestoneRows, overdue} from './milestones.ts';
import {useRepoCounts} from './repoCounts.ts';
import {editMilestone, isPending, type RepoRef, viewMilestones} from './writes.ts';
import {CheckCircleIcon, MilestoneIcon, PencilIcon, UndoIcon, TrashIcon} from '@primer/octicons-react';
import {Button, Label, ProgressBar, SegmentedControl} from '@primer/react';
import {Tooltip} from '@primer/react';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {SkeletonBox} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

const milestonesApi = getRouteApi('/shell/$owner/$repo/milestones');

const ENTRY = 'flex flex-col gap-2 border-b border-muted px-4 py-3 last:border-b-0';

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
  // The search field's shortcut lives in the list scope.
  useShortcutScope('list');
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
    <Tooltip text={offline ? onlineOnly('Creating a milestone') : 'Create a milestone'}><RouterLinkButton variant="primary" size="small" to="/$owner/$repo/milestones/new" params={{owner, repo}}>New milestone</RouterLinkButton></Tooltip>
  );
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={MilestoneIcon} title="Milestones">
        <IssueNav owner={owner} repo={repo} repoId={repoId} current="milestones"/>
        <SearchField label="Search milestones" value={search.q ?? ''} onChange={setTyped} onSettle={(text) => {
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
          <MetadataSection label="Milestones" title={
            <SegmentedControl aria-label="Milestone state" size="small" onChange={(index) => { go({state: index === 1 ? 'closed' : undefined}); }}>
              <SegmentedControl.Button selected={state === 'open'}>{`${String(open)} Open`}</SegmentedControl.Button>
              <SegmentedControl.Button selected={state === 'closed'}>{`${String(closed)} Closed`}</SegmentedControl.Button>
            </SegmentedControl>
          }>
            {loading ? <MilestonesSkeleton/> : (
              <ul className="flex flex-col">
                {shown.map((row) => <MilestoneEntry key={row.milestone.id} r={r} row={row} write={write} onDelete={() => {
                  setDeleting(row.milestone);
                }}/>)}
              </ul>
            )}
            {!loading && shown.length === 0 && (q.trim() ?
              <EmptyState title="No milestone matches" description="No milestone here has these words in its title or description."/> :
              state === 'closed' ?
                <EmptyState icon={CheckCircleIcon} title="No closed milestones" description="Milestones closed when their work is done are listed here."/> :
                <EmptyState icon={MilestoneIcon} title="No open milestones" description="Milestones group issues and pull requests towards a release or a date." action={create}/>)}
          </MetadataSection>
        </PageColumn>
      </PageBody>
      {deleting && <DeleteMilestoneDialog repo={r} milestone={deleting} onClose={() => {
        setDeleting(undefined);
      }}/>}
    </>
  );
});

const MilestoneEntry = observer(function MilestoneEntry({r, row, write, onDelete}: {r: RepoRef; row: MilestoneRow; write: boolean; onDelete: () => void}) {
  const app = useApp();
  const {owner, repo} = r;
  const {milestone: m, progress: p} = row;
  const offline = !connectivity.online;
  const temp = m.id < 0;
  const params = {owner, repo, index: String(m.id)};
  const late = overdue(m);
  return (
    <li className={clsx(ENTRY, '@xl:flex-row @xl:gap-6')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          {temp ? <span className="truncate text-default">{m.title}</span> :
            <Link to="/$owner/$repo/milestone/$index" params={params} className="min-w-0 truncate text-default hover:text-accent hover:underline">{m.title}</Link>}
          {isPending('Milestone', m.id) && <SavingIndicator label="Saving to Forgejo"/>}
          {late && <Label variant="danger">Overdue</Label>}
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <DueLine m={m}/>
          <span className="text-muted">Updated <TimeAgo at={m.updated_at} variant="words"/></span>
        </div>
        {m.description && <p className="truncate text-base text-muted">{excerpt(m.description)}</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-2 @xl:w-80">
        <ProgressBar barSize="small" progress={p.total > 0 ? Math.min(100, Math.max(0, (p.closed) / (p.total) * 100)) : 0} aria-label={`${String(p.closed)} of ${String(p.total)} closed`}/>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-muted tabular-nums">
          <span className="font-semibold text-default">{p.percent}% complete</span>
          {temp ? <span>{p.open} open</span> : <Link to="/$owner/$repo/milestone/$index" params={params} className="min-w-0 truncate text-default hover:text-accent hover:underline">{p.open} open</Link>}
          {temp ? <span>{p.closed} closed</span> : <Link to="/$owner/$repo/milestone/$index" params={params} search={{state: 'closed'}} className="min-w-0 truncate text-default hover:text-accent hover:underline">{p.closed} closed</Link>}
        </div>
        {write && !temp && (
          <div className="flex flex-wrap items-center gap-2">
            <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} to="/$owner/$repo/milestone/$index/edit" params={params}>Edit</RouterLinkButton>
            <Tooltip text={offline ? onlineOnly(m.state === 'closed' ? 'Reopening a milestone' : 'Closing a milestone') : m.state === 'closed' ? 'Reopen milestone' : 'Close milestone'}><Button variant="invisible" size="small" leadingVisual={m.state === 'closed' ? UndoIcon : CheckCircleIcon} type="button" inactive={offline} onClick={() => {
                const closing = m.state !== 'closed';
                void editMilestone(app, r, m, {state: closing ? 'closed' : 'open'}, `${closing ? 'Closing' : 'Reopening'} the milestone “${m.title}”`);
              }}>{m.state === 'closed' ? 'Reopen' : 'Close'}</Button></Tooltip>
            <Tooltip text={offline ? onlineOnly('Deleting a milestone') : 'Delete milestone'}><Button variant="invisible" size="small" leadingVisual={TrashIcon} type="button" inactive={offline} onClick={onDelete}>Delete</Button></Tooltip>
          </div>
        )}
      </div>
    </li>
  );
});

function MilestonesSkeleton() {
  return (
    <ul role="presentation" className="flex flex-col">
      {['w-40', 'w-56', 'w-32'].map((w) => (
        <li key={w} className={ENTRY}>
          <SkeletonBox className={`h-4 ${w}`}/>
          <SkeletonBox className="h-3 w-24"/>
          <SkeletonBox className="h-2 w-full"/>
        </li>
      ))}
    </ul>
  );
}
