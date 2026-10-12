// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import type {RepoRef} from '../../app/paths.ts';
import {getRouteApi, useNavigate, useParams} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState, createElement} from 'react';
import {Missing} from '../../app/Missing.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {MarkdownPreview} from '../editor/Composer.tsx';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import {milestoneProgress} from './counts.ts';
import {DeleteMilestoneDialog, DueLine} from './MilestoneActions.tsx';
import {useRepoCounts} from './repoCounts.ts';
import {editMilestone, viewMilestones} from './writes.ts';
import {ChevronDownIcon, CheckCircleIcon, MilestoneIcon, PencilIcon, UndoIcon, TrashIcon} from '@primer/octicons-react';
import {Button, ActionMenu, ActionList, ProgressBar} from '@primer/react';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {SkeletonText} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

const milestoneApi = getRouteApi('/shell/$owner/$repo/milestone/$index');

export function MilestonePage() {
  const {owner, repo, repoId} = useRepoPage();
  const {index = ''} = useParams({strict: false});
  const id = /^[1-9]\d{0,15}$/.test(index) ? Number(index) : 0;
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={MilestoneIcon} title="Milestone"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <MilestoneLookup key={`${String(repoId)}:${String(id)}`} r={{owner, name: repo, id: repoId}} id={id}/>;
}

const MilestoneLookup = observer(function MilestoneLookup({r, id}: {r: RepoRef; id: number}) {
  const s = useSession();
  const row = s.data.pool.model('Milestone').get(id)?.data;
  const m = row?.repo_id === r.id ? viewMilestones([row], r.id)[0] : undefined;
  if (m) return <MilestoneView r={r} m={m}/>;
  const loading = s.data.status.loading > 0;
  const path = `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/milestone/${String(id)}`;
  return (
    <>
      <RepoHeader owner={r.owner} repo={r.name} repoId={r.id} icon={MilestoneIcon} title="Milestone"/>
      <PageBody>
        {loading ? <PageColumn wide><SkeletonText lines={3}/></PageColumn> : <Missing what="This milestone" classic={id ? path : undefined}/>}
      </PageBody>
    </>
  );
});

const MilestoneView = observer(function MilestoneView({r, m}: {r: RepoRef; m: Milestone}) {
  const {owner, name: repo, id: repoId} = r;
  const search = milestoneApi.useSearch();
  const model = useListModel({kind: 'repo', repoId, pulls: 'any', milestone: m.id}, search, 'none');
  const write = useCanWrite(repoId);
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={MilestoneIcon} title={m.title} docTitle={`${m.title} · Milestones`}>
        <ListControls model={model} repoId={repoId} hideGroups={['repo', 'milestone']}/>
        {write && <MilestoneMenu r={r} m={m}/>}
      </RepoHeader>
      <Summary r={r} m={m}/>
      <ListBody model={model} label={`Issues and pull requests of ${m.title}`}
        empty={<EmptyState icon={MilestoneIcon} title="Nothing open in this milestone" description="Add issues and pull requests to it from their milestone (M)."/>}/>
    </>
  );
});

const Summary = observer(function Summary({r, m}: {r: RepoRef; m: Milestone}) {
  const counts = useRepoCounts(r.id).get().milestones;
  const p = milestoneProgress(m, counts.get(m.id));
  const [open, setOpen] = useState(false);
  const offline = !connectivity.online;
  return (
    <section aria-label="Milestone" className="flex shrink-0 flex-col gap-2 border-b border-default px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <DueLine m={m}/>
        <span className="font-semibold text-default tabular-nums">{p.percent}% complete</span>
        <span className="text-muted tabular-nums">{p.open} open · {p.closed} closed</span>
        {m.description && (
          <Button variant="invisible" size="small" type="button" trailingVisual={ChevronDownIcon} aria-expanded={open} onClick={() => {
            setOpen(!open);
          }}>{open ? 'Hide the description' : 'Show the description'}</Button>
        )}
      </div>
      <div className="max-w-lg"><ProgressBar barSize="small" progress={p.total > 0 ? Math.min(100, Math.max(0, (p.closed) / (p.total) * 100)) : 0} aria-label={`${String(p.closed)} of ${String(p.total)} closed`}/></div>
      {open && m.description && (
        <div className="max-h-dialog-body overflow-y-auto">
          {offline ? <pre className="whitespace-pre-wrap text-base">{m.description}</pre> : <MarkdownPreview repoId={r.id} text={m.description}/>}
        </div>
      )}
    </section>
  );
});

const MilestoneMenu = observer(function MilestoneMenu({r, m}: {r: RepoRef; m: Milestone}) {
  const app = useApp();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const offline = !connectivity.online;
  const closed = m.state === 'closed';
  return (
    <>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={PencilIcon} to="/$owner/$repo/milestone/$index/edit" params={{owner: r.owner, repo: r.name, index: String(m.id)}}>Edit</RouterLinkButton>
      <ActionMenu>
        <ActionMenu.Anchor><Button variant="invisible" size="small" type="button" trailingVisual={ChevronDownIcon} aria-label="Milestone actions">Milestone</Button></ActionMenu.Anchor>
        <ActionMenu.Overlay><ActionList>
          <ActionList.Item disabled={offline} onSelect={() => {
            void editMilestone(app, r, m, {state: closed ? 'open' : 'closed'}, `${closed ? 'Reopening' : 'Closing'} the milestone “${m.title}”`);
          }}><ActionList.LeadingVisual>{createElement(closed ? UndoIcon : CheckCircleIcon)}</ActionList.LeadingVisual>{closed ? 'Reopen the milestone' : 'Close the milestone'}<ActionList.TrailingVisual>{offline ? onlineOnly(closed ? 'Reopening a milestone' : 'Closing a milestone') : undefined}</ActionList.TrailingVisual></ActionList.Item>
          <ActionList.Item variant="danger" disabled={offline} onSelect={() => {
            setDeleting(true);
          }}><ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete the milestone…<ActionList.TrailingVisual>{offline ? onlineOnly('Deleting a milestone') : undefined}</ActionList.TrailingVisual></ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {deleting && <DeleteMilestoneDialog repo={r} milestone={m} onClose={() => {
        setDeleting(false);
      }} onDeleted={() => {
        void navigate({to: '/$owner/$repo/milestones', params: {owner: r.owner, repo: r.name}});
      }}/>}
    </>
  );
});
