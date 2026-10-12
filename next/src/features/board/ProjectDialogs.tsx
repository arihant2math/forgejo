// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {repoGroup, groupName} from '../../data/models.ts';
import {useRef, useState} from 'react';
import {useNavigate} from '@tanstack/react-router';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {canEditBoard} from '../../app/access.ts';
import {onlineWrite} from '../../app/api.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Project} from '../../protocol/types.gen.ts';
import {Banner, Button, ActionMenu, ActionList, Dialog, FormControl, SegmentedControl, Select, TextInput, Textarea, Tooltip} from '@primer/react';

export interface BoardScope {repo_id: number; owner_id: number}
export const pendingBoards = observable.map<string, BoardScope & {title: string}>();
const templates = [{value: 'none', label: 'None'}, {value: 'basic_kanban', label: 'Basic kanban'}, {value: 'bug_triage', label: 'Bug triage'}] as const;
const cards = [{value: 'text_only', label: 'Text only'}, {value: 'images_and_text', label: 'Images and text'}];

function failure(err: unknown): string { return err instanceof Error ? err.message : 'Something went wrong.'; }

export const NewBoard = observer(function NewBoard({scope, primary = false}: {scope?: BoardScope | undefined; primary?: boolean}) {
  const [open, setOpen] = useState(false);
  const session = useSession();
  const available = scope ? canEditBoard(session, scope) : true;
  if (!available) return null;
  return <><Tooltip text={!connectivity.online ? onlineOnly('Creating a board') : 'Create a project board'}><Button size="small" variant={primary ? 'primary' : 'default'} type="button" inactive={!connectivity.online} onClick={() => { setOpen(true); }}>New board</Button></Tooltip>
    {open && <BoardForm scope={scope} onClose={() => { setOpen(false); }}/>}</>;
});

const BoardForm = observer(function BoardForm({scope, project, onClose}: {scope?: BoardScope | undefined; project?: Project | undefined; onClose: () => void}) {
  const app = useApp();
  const s = useSession();
  const navigate = useNavigate();
  const choices = [{value: `owner:${String(s.userId)}`, label: 'My projects', scope: {repo_id: 0, owner_id: s.userId}}];
  for (const r of s.data.pool.model('Repository').all()) {
    const target = {repo_id: r.id, owner_id: 0};
    if (canEditBoard(s, target)) choices.push({value: `repo:${String(r.id)}`, label: r.get('full_name'), scope: target});
  }
  for (const u of s.data.pool.model('User').all()) {
    const target = {repo_id: 0, owner_id: u.id};
    if (u.get('type') === 'organization' && canEditBoard(s, target)) choices.push({value: `owner:${String(u.id)}`, label: u.get('login'), scope: target});
  }
  const [target, setTarget] = useState(choices[0]?.value ?? '');
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(project?.title ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [template, setTemplate] = useState<string>('none');
  const [cardType, setCardType] = useState(project?.card_type === 1 ? 'images_and_text' : 'text_only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{id: number; group: string; syncId: number | undefined}>();
  const save = async () => {
    if (busy || !title.trim() || !connectivity.online) return;
    const destination = scope ?? choices.find((c) => c.value === target)?.scope;
    if (!project && !destination) return;
    setBusy(true);
    setError('');
    const pending = crypto.randomUUID();
    if (!project && destination && !created) runInAction(() => pendingBoards.set(pending, {...destination, title: title.trim()}));
    try {
      let ready = created;
      if (!ready) {
        const made = await onlineWrite<{id: number}>(app, {api: 'sync', method: project ? 'PATCH' : 'POST', path: project ? `/projects/${String(project.id)}` : '/projects', body: {
          ...(project ? {} : destination), title: title.trim(), description, card_type: cardType, ...(project ? {} : {template_type: template}),
        }});
        if (!project) {
          const id = made.value?.id;
          if (!id || !destination) throw new Error('Forgejo did not return the board ID.');
          const owner = s.data.pool.model('User').get(destination.owner_id);
          const group = destination.repo_id ? repoGroup(destination.repo_id) : groupName(owner?.get('type') === 'organization' ? 'org' : 'profile', destination.owner_id);
          ready = {id, group, syncId: made.syncId};
          setCreated(ready);
        }
      }
      if (ready) {
        s.data.hold(ready.group);
        try {
          if (ready.syncId) await s.data.whenSynced(ready.group, ready.syncId, AbortSignal.timeout(15_000));
          await navigate({to: '/-/next/projects/$id', params: {id: String(ready.id)}});
        } finally { s.data.release(ready.group); }
      }
      onClose();
    } catch (err) { setError(failure(err)); } finally {
      runInAction(() => pendingBoards.delete(pending));
      setBusy(false);
    }
  };
  return <Dialog title={project ? 'Edit board' : 'New board'} width="large" initialFocusRef={titleRef} onClose={() => { if (!busy) onClose(); }} footerButtons={[
    {content: 'Cancel', disabled: busy, onClick: onClose},
    {content: busy ? created ? 'Syncing…' : 'Saving…' : created ? 'Open board' : project ? 'Save changes' : 'Create board', buttonType: 'primary', disabled: busy || !title.trim() || !connectivity.online, onClick: () => void save()},
  ]}>
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {!scope && !project && <FormControl id="board-location"><FormControl.Label>Location</FormControl.Label><Select id="board-location" value={target} onChange={(e) => { setTarget(e.target.value); }} disabled={busy || !!created}>{choices.map((choice) => <Select.Option key={choice.value} value={choice.value}>{choice.label}</Select.Option>)}</Select></FormControl>}
      <FormControl id="board-title"><FormControl.Label>Title</FormControl.Label><TextInput ref={titleRef} id="board-title" block value={title} maxLength={255} required disabled={busy || !!created} onChange={(e) => { setTitle(e.target.value); }}/></FormControl>
      <FormControl id="board-description"><FormControl.Label>Description</FormControl.Label><Textarea id="board-description" value={description} rows={3} disabled={busy || !!created} onChange={(e) => { setDescription(e.target.value); }} block/></FormControl>
      {!project && <FormControl id="board-template"><FormControl.Label>Template</FormControl.Label><SegmentedControl aria-label="Template" onChange={(index) => { const choice = index === undefined ? undefined : templates[index]; if (choice) setTemplate(choice.value); }}>{templates.map((choice) => <SegmentedControl.Button key={choice.value} selected={template === choice.value} disabled={busy || !!created}>{choice.label}</SegmentedControl.Button>)}</SegmentedControl></FormControl>}
      <FormControl id="board-card-type"><FormControl.Label>Cards</FormControl.Label><Select id="board-card-type" value={cardType} onChange={(e) => { setCardType(e.target.value); }} disabled={busy || !!created}>{cards.map((choice) => <Select.Option key={choice.value} value={choice.value}>{choice.label}</Select.Option>)}</Select></FormControl>
      {!connectivity.online && <Banner variant="warning" title={onlineOnly('Saving a board')}/>}
      {error && <Banner variant="critical" title={created ? 'Board created; sync is still catching up' : 'Board not saved'} description={created ? 'Choose Open board to retry waiting for sync. The board will not be created twice.' : error}/>}
    </form>
  </Dialog>;
});

export const BoardSettings = observer(function BoardSettings({project}: {project: Project}) {
  const app = useApp();
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (deleting: boolean) => {
    if (busy || !connectivity.online) return;
    setBusy(true); setError('');
    try {
      await onlineWrite(app, {api: 'sync', method: deleting ? 'DELETE' : 'PUT', path: `/projects/${String(project.id)}${deleting ? '' : '/state'}`, ...(deleting ? {} : {body: {closed: !project.closed}})});
      if (deleting) await navigate({to: '/-/next/boards'});
    } catch (err) { setError(failure(err)); } finally { setBusy(false); }
  };
  const reason = !connectivity.online ? onlineOnly('Changing a board') : 'Manage this board';
  return <>
    <ActionMenu><ActionMenu.Anchor><Button size="small" type="button" disabled={busy} inactive={!connectivity.online} aria-describedby={!connectivity.online ? "board-settings-offline" : undefined}>Board settings</Button></ActionMenu.Anchor><ActionMenu.Overlay><ActionList>
      <ActionList.Item onSelect={() => { setEdit(true); }}>Edit board</ActionList.Item>
      <ActionList.Item onSelect={() => void change(false)}>{project.closed ? 'Reopen board' : 'Close board'}</ActionList.Item>
      <ActionList.Divider/><ActionList.Item variant="danger" onSelect={() => { setError(''); setConfirmation(''); setRemove(true); }}>Delete board…</ActionList.Item>
    </ActionList></ActionMenu.Overlay></ActionMenu>
    {edit && <BoardForm project={project} onClose={() => { setEdit(false); }}/>}
    {!connectivity.online && <span id="board-settings-offline">{reason}</span>}
    {error && !remove && <Banner variant="critical" title="Board not changed" description={error}/>}
    {remove && <Dialog title="Delete board?" initialFocusRef={confirmationRef} subtitle="This permanently removes the board and its columns. Issues are not deleted." onClose={() => { if (!busy) setRemove(false); }} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: () => { setRemove(false); }},
      {content: busy ? 'Deleting…' : 'Delete board', buttonType: 'danger', disabled: busy || !connectivity.online || confirmation !== project.title, onClick: () => void change(true)},
    ]}>
      <FormControl>
        <FormControl.Label>Type {project.title} to confirm.</FormControl.Label>
        <TextInput ref={confirmationRef} block value={confirmation} autoComplete="off" spellCheck={false} disabled={busy}
          onChange={(e) => { setConfirmation(e.target.value); }} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && connectivity.online && confirmation === project.title) void change(true);
            }
          }}/>
      </FormControl>
      {!connectivity.online && <Banner variant="warning" title={onlineOnly('Deleting a board')}/>}
      {error && <Banner variant="critical" title="Board not deleted" description={error}/>}
    </Dialog>}
  </>;
});
