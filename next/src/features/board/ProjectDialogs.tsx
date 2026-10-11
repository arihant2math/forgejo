// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {useNavigate} from '@tanstack/react-router';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {canEditBoard} from '../../app/access.ts';
import {onlineWrite} from '../../app/api.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Project} from '../../protocol/types.gen.ts';
import {Callout, ConfirmDialog, Field, Input, SegmentedControl, Select, TextArea} from '../../ui/index.ts';
import {Button, ActionMenu, ActionList, Dialog} from '@primer/react';

export interface BoardScope {repo_id: number; owner_id: number}
export const pendingBoards = observable.map<string, BoardScope & {title: string}>();
const templates = [{value: 'none', label: 'None'}, {value: 'basic_kanban', label: 'Basic kanban'}, {value: 'bug_triage', label: 'Bug triage'}] as const;
const cards = [{value: 'text_only', label: 'Text only'}, {value: 'images_and_text', label: 'Images and text'}];

function failure(err: unknown): string { return err instanceof Error ? err.message : 'Something went wrong.'; }

export const NewBoard = observer(function NewBoard({scope}: {scope?: BoardScope | undefined}) {
  const [open, setOpen] = useState(false);
  const session = useSession();
  const available = scope ? canEditBoard(session, scope) : true;
  if (!available) return null;
  return <><Button size="small" type="button" disabled={!connectivity.online} title={!connectivity.online ? onlineOnly('Creating a board') : undefined} onClick={() => { setOpen(true); }}>New board</Button>
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
          const group = destination.repo_id ? `repo:${String(destination.repo_id)}` : `${owner?.get('type') === 'organization' ? 'org' : 'profile'}:${String(destination.owner_id)}`;
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
  return <Dialog title={project ? 'Edit board' : 'New board'} width="large" onClose={() => { const o = false; if (!o && !busy) onClose(); }} renderFooter={() => <Dialog.Footer>{<>
    <Button variant="invisible" type="button" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button variant="primary" type="button" disabled={busy || !title.trim() || !connectivity.online} title={!connectivity.online ? onlineOnly('Saving a board') : undefined} onClick={() => void save()}>{busy ? created ? 'Syncing…' : 'Saving…' : created ? 'Open board' : project ? 'Save changes' : 'Create board'}</Button>
  </>}</Dialog.Footer>}>
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {!scope && !project && <Field label="Location" htmlFor="board-location"><Select id="board-location" value={target} onValueChange={setTarget} options={choices} disabled={busy || !!created}/></Field>}
      <Field label="Title" htmlFor="board-title"><Input id="board-title" className="w-full" value={title} maxLength={255} required disabled={busy || !!created} onChange={(e) => { setTitle(e.target.value); }}/></Field>
      <Field label="Description" htmlFor="board-description" optional><TextArea id="board-description" value={description} rows={3} disabled={busy || !!created} onChange={(e) => { setDescription(e.target.value); }}/></Field>
      {!project && <Field label="Template" htmlFor="board-template"><SegmentedControl label="Template" value={template} onChange={setTemplate} options={templates.map((t) => ({...t, disabled: busy || !!created}))}/></Field>}
      <Field label="Cards" htmlFor="board-card-type"><Select id="board-card-type" value={cardType} onValueChange={setCardType} options={cards} disabled={busy || !!created}/></Field>
      {error && <Callout tone="danger" title={created ? 'Board created; sync is still catching up' : 'Board not saved'}>{created ? 'Choose Open board to retry waiting for sync. The board will not be created twice.' : error}</Callout>}
    </form>
  </Dialog>;
});

export const BoardSettings = observer(function BoardSettings({project}: {project: Project}) {
  const app = useApp();
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
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
  const reason = !connectivity.online ? onlineOnly('Changing a board') : undefined;
  return <>
    <ActionMenu><ActionMenu.Anchor><Button size="small" type="button" disabled={busy || !connectivity.online} title={reason}>Board settings</Button></ActionMenu.Anchor><ActionMenu.Overlay><ActionList>
      <ActionList.Item onSelect={() => { setEdit(true); }}>Edit board</ActionList.Item>
      <ActionList.Item onSelect={() => void change(false)}>{project.closed ? 'Reopen board' : 'Close board'}</ActionList.Item>
      <ActionList.Divider/><ActionList.Item variant="danger" onSelect={() => { setError(''); setRemove(true); }}>Delete board…</ActionList.Item>
    </ActionList></ActionMenu.Overlay></ActionMenu>
    {edit && <BoardForm project={project} onClose={() => { setEdit(false); }}/>}
    {error && !remove && <Callout tone="danger" title="Board not changed">{error}</Callout>}
    <ConfirmDialog open={remove} onOpenChange={setRemove} title="Delete board?" description="This permanently removes the board and its columns. Issues are not deleted." confirmLabel="Delete board" confirmText={project.title} busy={busy} error={error} ready={connectivity.online} onConfirm={() => void change(true)}/>
  </>;
});
