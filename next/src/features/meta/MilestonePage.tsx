// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A milestone (/{owner}/{repo}/milestone/{id}): its due date, progress and
// description over its issues and pull requests — the repository's issue
// list (the same live query, rows, keys and filters) fixed to this
// milestone. Writers edit, close or reopen and delete it (online).

import {getRouteApi, Link, useNavigate, useParams} from '@tanstack/react-router';
import {ChevronDown, CircleCheck, Milestone as MilestoneIcon, Pencil, RotateCcw, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {Missing} from '../../app/Missing.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {Button, EmptyState, Icon, Menu, MenuContent, MenuItem, MenuTrigger, ProgressBar, ProseSource, SkeletonText} from '../../ui/index.ts';
import {MarkdownPreview} from '../editor/Composer.tsx';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import {milestoneProgress} from './counts.ts';
import {DeleteMilestoneDialog, DueLine} from './MilestoneActions.tsx';
import {useRepoCounts} from './repoCounts.ts';
import {editMilestone, type RepoRef, viewMilestones} from './writes.ts';

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
  return <MilestoneLookup key={`${String(repoId)}:${String(id)}`} r={{owner, repo, repoId}} id={id}/>;
}

/** The milestone from the pool (its repository's group is held by the page); not found once that has loaded. */
const MilestoneLookup = observer(function MilestoneLookup({r, id}: {r: RepoRef; id: number}) {
  const s = useSession();
  const row = s.data.pool.model('Milestone').get(id)?.data;
  const m = row?.repo_id === r.repoId ? viewMilestones([row], r.repoId)[0] : undefined;
  if (m) return <MilestoneView r={r} m={m}/>;
  const loading = s.data.status.loading > 0;
  const path = `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/milestone/${String(id)}`;
  return (
    <>
      <RepoHeader owner={r.owner} repo={r.repo} repoId={r.repoId} icon={MilestoneIcon} title="Milestone"/>
      <PageBody>
        {loading ? <PageColumn wide><SkeletonText lines={3}/></PageColumn> : <Missing what="This milestone" classic={id ? path : undefined}/>}
      </PageBody>
    </>
  );
});

const MilestoneView = observer(function MilestoneView({r, m}: {r: RepoRef; m: Milestone}) {
  const {owner, repo, repoId} = r;
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

/** The milestone's due date, progress and description, above its list (outside the list's scroll: the rows virtualize). */
const Summary = observer(function Summary({r, m}: {r: RepoRef; m: Milestone}) {
  const counts = useRepoCounts(r.repoId).get().milestones;
  const p = milestoneProgress(m, counts.get(m.id));
  const [open, setOpen] = useState(false);
  const offline = !connectivity.online;
  return (
    <section aria-label="Milestone" className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <DueLine m={m}/>
        <span className="font-semibold text-fg tabular-nums">{p.percent}% complete</span>
        <span className="text-fg-muted tabular-nums">{p.open} open · {p.closed} closed</span>
        {m.description && (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => {
            setOpen(!open);
          }}>{open ? 'Hide the description' : 'Show the description'}<Icon icon={ChevronDown} size="sm"/></Button>
        )}
      </div>
      <div className="max-w-lg"><ProgressBar value={p.closed} max={p.total} label={`${String(p.closed)} of ${String(p.total)} closed`}/></div>
      {open && m.description && (
        <div className="max-h-dialog-body overflow-y-auto">
          {offline ? <ProseSource text={m.description}/> : <MarkdownPreview repoId={r.repoId} text={m.description}/>}
        </div>
      )}
    </section>
  );
});

/** A writer's actions on the milestone: edit, close or reopen, delete. */
const MilestoneMenu = observer(function MilestoneMenu({r, m}: {r: RepoRef; m: Milestone}) {
  const app = useApp();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const offline = !connectivity.online;
  const closed = m.state === 'closed';
  return (
    <>
      <Button size="sm" variant="ghost" asChild>
        <Link to="/$owner/$repo/milestone/$index/edit" params={{owner: r.owner, repo: r.repo, index: String(m.id)}}><Icon icon={Pencil} size="sm"/>Edit</Link>
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Milestone actions">Milestone<Icon icon={ChevronDown} size="sm"/></Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={closed ? RotateCcw : CircleCheck} disabled={offline} hint={offline ? onlineOnly(closed ? 'Reopening a milestone' : 'Closing a milestone') : undefined} onSelect={() => {
            void editMilestone(app, r, m, {state: closed ? 'open' : 'closed'}, `${closed ? 'Reopening' : 'Closing'} the milestone “${m.title}”`);
          }}>{closed ? 'Reopen the milestone' : 'Close the milestone'}</MenuItem>
          <MenuItem icon={Trash2} danger disabled={offline} hint={offline ? onlineOnly('Deleting a milestone') : undefined} onSelect={() => {
            setDeleting(true);
          }}>Delete the milestone…</MenuItem>
        </MenuContent>
      </Menu>
      {deleting && <DeleteMilestoneDialog repo={r} milestone={m} onClose={() => {
        setDeleting(false);
      }} onDeleted={() => {
        void navigate({to: '/$owner/$repo/milestones', params: {owner: r.owner, repo: r.repo}});
      }}/>}
    </>
  );
});
