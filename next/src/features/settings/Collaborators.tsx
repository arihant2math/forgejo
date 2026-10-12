// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {SkeletonAvatar} from '@primer/react/experimental';

import type {SelectPanelItemInput} from '@primer/react';
import {enterPicksFirst, VIRTUALIZE_OVER} from '../../components/pickOptions.ts';
import {SelectPanel, Select, Avatar, Button, IconButton, ConfirmationDialog, Dialog, FormControl, Radio, RadioGroup} from '@primer/react';
import {ResourceRow} from '../../components/ResourceRow.tsx';
import {FormSection} from '../usersettings/form.tsx';

// Sync represents administrators as writers; API v1 supplies exact roles.
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {RepositoryTeams} from '../owner/Teams.tsx';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import {usePool} from '../../app/store.ts';
import {ResourceList} from './bits.tsx';
import {useReach} from '../../app/online.ts';
import {problemOf} from './problems.ts';
import {type FoundUser, fetchCollaborators, putCollaborator, removeCollaborator, searchUsers} from './requests.ts';
import {useResource} from '../../app/resource.ts';
import {settingsKey} from './resource.ts';
import {byLogin, type Collaborator, type Role, roleOf, ROLES} from './rules.ts';
import {TrashIcon, PersonAddIcon, PeopleIcon} from '@primer/octicons-react';

export const CollaboratorSettings = observer(function CollaboratorSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const pool = usePool();
  const offline = useReach() !== 'online';
  const [removing, setRemoving] = useState<Collaborator | undefined>(undefined);
  const res = useResource(settingsKey(repoId, 'collaborators'), (signal) => fetchCollaborators(app, owner, repo, signal));
  const fromPool: Collaborator[] = [];
  for (const c of pool.model('Collaboration').by('repo_id', repoId)) {
    const u = pool.model('User').get(c.get('user_id'))?.data;
    if (u) fromPool.push({id: u.id, login: u.login, name: u.full_name || u.login, avatar: u.avatar_url, role: roleOf(c.get('permission')), approximate: true});
  }
  fromPool.sort(byLogin);
  const shown = res.value === undefined && fromPool.length ? {...res, value: fromPool, state: 'ready' as const} : res;
  const org = pool.model('User').get(pool.model('Repository').get(repoId)?.get('owner_id') ?? 0)?.get('type') === 'organization';

  const setRole = (c: Collaborator, role: Role) => {
    res.update((list) => (list ?? fromPool).map((x) => (x.id === c.id ? {...x, role, approximate: false} : x)));
    putCollaborator(app, owner, repo, c.login, role).then(() => {
      notify(app, {tone: 'success', title: `${c.login} can now ${role === 'read' ? 'read' : role === 'write' ? 'write' : 'administer'} ${repo}`});
    }, (err: unknown) => {
      res.update((list) => (list ?? []).map((x) => (x.id === c.id ? c : x)));
      notify(app, {tone: 'danger', title: `${c.login}’s role was not changed`, description: problemOf(err).message});
    });
  };
  const add = (u: FoundUser, role: Role) => {
    const c: Collaborator = {id: u.id, login: u.login, name: u.name, avatar: u.avatar, role};
    res.update((list) => [...(list ?? fromPool).filter((x) => x.id !== u.id), c].sort(byLogin));
    putCollaborator(app, owner, repo, u.login, role).then(() => {
      notify(app, {tone: 'success', title: `Added ${u.login}`});
    }, (err: unknown) => {
      res.update((list) => (list ?? []).filter((x) => x.id !== u.id));
      notify(app, {tone: 'danger', title: `${u.login} was not added`, description: problemOf(err).message});
    });
  };
  const remove = (c: Collaborator) => {
    res.update((list) => (list ?? fromPool).filter((x) => x.id !== c.id));
    removeCollaborator(app, owner, repo, c.login).then(() => {
      notify(app, {tone: 'success', title: `Removed ${c.login}`, action: {label: 'Undo', run: () => {
        add({id: c.id, login: c.login, name: c.name, avatar: c.avatar}, c.role);
      }}});
    }, (err: unknown) => {
      res.update((list) => [...(list ?? []).filter((x) => x.id !== c.id), c].sort(byLogin));
      notify(app, {tone: 'danger', title: `${c.login} was not removed`, description: problemOf(err).message});
    });
  };
  const members = new Set((shown.value ?? []).map((c) => c.id));

  return (
    <FormSection id="settings-collaborators" title="Collaborators" description="People with access to this repository besides its owner."
      actions={<AddPerson repo={repo} disabled={offline} members={members} onAdd={add}/>}>
      <ResourceList res={shown} what="The collaborators" empty={{icon: PeopleIcon, title: 'No collaborators', description: 'Add people to give them access to this repository.'}}>
        {(list) => list.map((c) => (
          <ResourceRow key={c.id} leading={c.avatar ? <Avatar alt={c.login} src={c.avatar} size={20}/> : <SkeletonAvatar size={20}/>} title={c.name} meta={c.name !== c.login ? c.login : undefined}
            description={c.approximate ? 'Checking the exact role…' : undefined}
            actions={<>
              <Select size="small" aria-label={`${c.login}’s role`} value={c.role} disabled={offline} onChange={(event) => {
                const role = event.target.value as Role;
                if (role !== c.role) setRole(c, role);
              }}>{ROLES.map((role) => <Select.Option key={role.value} value={role.value}>{role.label}</Select.Option>)}</Select>
              <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Remove ${c.login}`} type="button" disabled={offline} onClick={() => {
                setRemoving(c);
              }}/>
            </>}/>
        ))}
      </ResourceList>
      {removing && <ConfirmationDialog title={`Remove ${removing.login}?`} confirmButtonContent="Remove collaborator" confirmButtonType="danger" onClose={(gesture) => {
        if (gesture === 'confirm' && !offline) remove(removing);
        setRemoving(undefined);
      }}>They will lose their collaborator access to this repository.</ConfirmationDialog>}
      {org && <RepositoryTeams owner={owner} repo={repo} repoId={repoId}/>}
    </FormSection>
  );
});

function AddPerson({repo, disabled, members, onAdd}: {repo: string; disabled: boolean; members: ReadonlySet<number>; onAdd: (u: FoundUser, role: Role) => void}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FoundUser | undefined>(undefined);
  const [role, setRole] = useState<Role>('write');
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open && wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const close = () => { setPicked(undefined); };
  return (
    <>
      <Button ref={button} variant="primary" size="small" leadingVisual={PersonAddIcon} disabled={disabled} onClick={() => { setOpen(true); }}>Add people</Button>
      {open && <PeopleSearch members={members} onPick={(user) => {
        setRole('write');
        setPicked(user);
        setOpen(false);
      }} onClose={() => { setOpen(false); }}/>}
      {picked && (
        <Dialog title={`Add ${picked.login} to ${repo}`} width="medium" returnFocusRef={button} onClose={close} footerButtons={[
          {content: 'Cancel', onClick: close},
          {content: `Add ${picked.login} to this repository`, buttonType: 'primary', disabled, onClick: () => {
            onAdd(picked, role);
            close();
          }},
        ]}>
          <RadioGroup name="collaborator-role" onChange={(value) => { if (value) setRole(value as Role); }}>
            <RadioGroup.Label>Choose a role</RadioGroup.Label>
            {ROLES.map((choice) => (
              <FormControl key={choice.value}>
                <Radio value={choice.value} checked={role === choice.value}/>
                <FormControl.Label>{choice.label}</FormControl.Label>
                <FormControl.Caption>{choice.description}</FormControl.Caption>
              </FormControl>
            ))}
          </RadioGroup>
        </Dialog>
      )}
    </>
  );
}

export function PeopleSearch({members, onPick, onClose, label = 'Add a collaborator', excludeSelf = true}: {members: ReadonlySet<number>; onPick: (u: FoundUser) => void; onClose: () => void; label?: string; excludeSelf?: boolean}) {
  const app = useApp();
  const anchor = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const {userId} = useSession();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{q: string; users: FoundUser[]; error?: string}>({q: '', users: []});
  useEffect(() => {
    const q = query.trim();
    if (!q) return undefined;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchUsers(app, q, ctl.signal).then((users) => {
        setFound({q, users});
      }, (err: unknown) => {
        if (!ctl.signal.aborted) setFound({q, users: [], error: problemOf(err).message});
      });
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [app, query]);
  const q = query.trim();
  const users = q && found.q === q ? found.users.filter((user) => !excludeSelf || user.id !== userId) : [];
  const empty = !q ? 'Type a login or a name.' : found.q !== q ? 'Searching…' : found.error ?? 'Nobody by that name.';
  return <SelectPanel title={label} variant="anchored" onCancel={onClose} open onOpenChange={(open) => { if (!open) onClose(); }}
    renderAnchor={null} anchorRef={anchor} selected={undefined} filterValue={query} onFilterChange={setQuery}
    placeholderText="Search people…" inputLabel="Search people…" virtualized={users.length > VIRTUALIZE_OVER} textInputProps={{onKeyDown: enterPicksFirst}}
    {...(users.length ? {} : {message: {title: empty, variant: found.error ? 'error' as const : 'empty' as const, body: ''}})}
    items={users.map((user) => ({
      id: user.id, text: user.name, description: members.has(user.id) ? 'Already added' : user.login,
      disabled: members.has(user.id), leadingVisual: () => user.avatar ? <Avatar size={24} alt={user.login} src={user.avatar}/> : <SkeletonAvatar size={24}/>,
    }))}
    onSelectedChange={(item: SelectPanelItemInput | undefined) => {
      if (!item) return;
      const user = users.find((user) => user.id === item.id);
      if (user && !members.has(user.id)) onPick(user);
    }}/>;
}
