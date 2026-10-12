// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {useNavigate, useParams} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {type SyntheticEvent, useId, useState} from 'react';
import {Missing} from '../../app/Missing.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {MarkdownField} from '../editor/Composer.tsx';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import {MAX_DUE, milestoneDraft, type MilestoneDraft, milestoneProblems} from './milestones.ts';
import {createMilestone, editMilestone, type MilestoneChange, type RepoRef, viewMilestones} from './writes.ts';
import {MilestoneIcon, XIcon} from '@primer/octicons-react';
import {Button, TextInput, FormControl} from '@primer/react';
import {Banner, Heading, Tooltip} from '@primer/react';
import {SkeletonText} from '@primer/react/experimental';

export function NewMilestone() {
  return <FormPage edit={false}/>;
}

export function EditMilestone() {
  return <FormPage edit/>;
}

function FormPage({edit}: {edit: boolean}) {
  const {owner, repo, repoId} = useRepoPage();
  const {index = ''} = useParams({strict: false});
  const title = edit ? 'Edit milestone' : 'New milestone';
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={MilestoneIcon} title={title}/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  const r = {owner, repo, repoId};
  return edit ? <EditLookup key={index} r={r} id={/^[1-9]\d{0,15}$/.test(index) ? Number(index) : 0}/> : <Form r={r} milestone={undefined}/>;
}

const EditLookup = observer(function EditLookup({r, id}: {r: RepoRef; id: number}) {
  const s = useSession();
  const row = s.data.pool.model('Milestone').get(id)?.data;
  const m = row?.repo_id === r.repoId ? viewMilestones([row], r.repoId)[0] : undefined;
  if (m) return <Form key={m.id} r={r} milestone={m}/>;
  return (
    <>
      <RepoHeader owner={r.owner} repo={r.repo} repoId={r.repoId} icon={MilestoneIcon} title="Edit milestone"/>
      <PageBody>
        {s.data.status.loading > 0 ? <PageColumn><SkeletonText lines={4}/></PageColumn> :
          <Missing what="This milestone" classic={id ? `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/milestone/${String(id)}/edit` : undefined}/>}
      </PageBody>
    </>
  );
});

const Form = observer(function Form({r, milestone}: {r: RepoRef; milestone: Milestone | undefined}) {
  const app = useApp();
  const navigate = useNavigate();
  const write = useCanWrite(r.repoId);
  const [d, setD] = useState<MilestoneDraft>(() => milestoneDraft(milestone));
  const [tried, setTried] = useState(false);
  const id = useId();
  const problems = milestoneProblems(d);
  const offline = !connectivity.online;
  const params = {owner: r.owner, repo: r.repo};
  const back = () => {
    if (milestone) void navigate({to: '/$owner/$repo/milestone/$index', params: {...params, index: String(milestone.id)}});
    else void navigate({to: '/$owner/$repo/milestones', params});
  };
  const save = (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (problems.title || problems.due) {
      setTried(true);
      document.getElementById(problems.title ? `${id}-title` : `${id}-due`)?.focus();
      return;
    }
    if (offline) return;
    if (!milestone) {
      void createMilestone(app, r, d);
      back();
      return;
    }
    const before = milestoneDraft(milestone);
    const change: MilestoneChange = {};
    if (d.title.trim() !== before.title) change.title = d.title;
    if (d.description !== before.description) change.description = d.description;
    if (d.due !== before.due) change.due = d.due;
    if (Object.keys(change).length) void editMilestone(app, r, milestone, change);
    back();
  };
  const title = milestone ? 'Edit milestone' : 'New milestone';
  return (
    <>
      <RepoHeader owner={r.owner} repo={r.repo} repoId={r.repoId} icon={MilestoneIcon} title={milestone ? milestone.title : title}
        docTitle={milestone ? `Edit ${milestone.title} · Milestones` : 'New milestone'}/>
      <PageBody>
        <PageColumn>
          <Heading as="h2" variant="medium">{title}</Heading>
          {!write && <Banner title="You cannot change this repository’s milestones" description="Forgejo would refuse it: changing milestones needs write access to the repository’s issues."/>}
          {offline && <Banner title={onlineOnly('Saving a milestone')} description="What you type stays here until you are back online."/>}
          {/* noValidate: each field's problem shows under it (milestoneProblems), not as the browser's bubble. */}
          <form className="flex flex-col gap-4" noValidate onSubmit={save}>
            <FormControl id={`${id}-title`}><FormControl.Label>Title</FormControl.Label>
              <TextInput value={d.title} autoFocus maxLength={255} placeholder="v1.2, Sprint 14, …" className="w-full" onChange={(e) => {
                  setD({...d, title: e.target.value});
                }}/>
            {tried && problems.title && <FormControl.Validation variant="error">{problems.title}</FormControl.Validation>}</FormControl>
            <FormControl id={`${id}-due`}><FormControl.Label>Due date</FormControl.Label>
              <TextInput type="date" value={d.due} max={MAX_DUE} className="w-48" onChange={(e) => {
                  setD({...d, due: e.target.value});
                }} {...(d.due ? {trailingAction: <TextInput.Action icon={XIcon} aria-label="Clear the due date" onClick={() => { setD({...d, due: ''}); }}/>} : {})}/>
            <FormControl.Caption>Optional. Issues of the milestone are due by then.</FormControl.Caption>{tried && problems.due && <FormControl.Validation variant="error">{problems.due}</FormControl.Validation>}</FormControl>
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold text-default">Description</span>
              <MarkdownField repoId={r.repoId} label="Description" placeholder="What the milestone is about (optional)" value={d.description} rows={8} onChange={(description) => {
                setD((x) => ({...x, description}));
              }} onSubmit={save}/>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="invisible" type="button" onClick={back}>Cancel</Button>
              <Tooltip text={offline ? onlineOnly('Saving a milestone') : 'Save milestone'}><Button variant="primary" type="submit" inactive={offline || !write}>
                {milestone ? 'Save changes' : 'Create milestone'}
              </Button></Tooltip>
            </div>
          </form>
        </PageColumn>
      </PageBody>
    </>
  );
});
