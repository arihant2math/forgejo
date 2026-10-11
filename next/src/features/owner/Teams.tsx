// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Trash2, Users} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Avatar, Button, CommandPick, Entry, IconButton, Panel, Popover, PopoverContent, PopoverTrigger} from '../../ui/index.ts';
import {PeopleSearch} from '../settings/Collaborators.tsx';
import {ResourceList, useOffline} from '../settings/bits.tsx';
import {allPages, type FoundUser, repoApi} from '../settings/requests.ts';
import {useResource} from '../settings/resource.ts';

interface Team {id: number; name: string; description: string; permission: string}
interface Member {id: number; login: string; full_name: string; avatar_url: string}

export function useOrgPermissions(owner: string) {
  const app = useApp();
  const s = useSession();
  const viewer = s.data.pool.model('User').get(s.userId)?.get('login');
  return useResource(`org:${owner}:permissions:${viewer ?? ''}`, async (signal) => {
    if (!viewer) return {is_owner: false, is_admin: false};
    return await online<{is_owner: boolean; is_admin: boolean}>(app, {api: 'v1', path: `/users/${encodeURIComponent(viewer)}/orgs/${encodeURIComponent(owner)}/permissions`, signal}) ?? {is_owner: false, is_admin: false};
  });
}

export const OrganizationTeams = observer(function OrganizationTeams({owner}: {owner: string}) {
  const app = useApp();
  const perms = useOrgPermissions(owner);
  const editable = perms.fresh && (perms.value?.is_owner === true || perms.value?.is_admin === true);
  const res = useResource(`org:${owner}:teams`, (signal) => allPages<Team>(app, `/orgs/${encodeURIComponent(owner)}/teams`, signal));
  const [selected, setSelected] = useState<number>();
  return <Panel label="Teams" title="Teams">
    <ResourceList res={res} what="The teams" empty={{icon: Users, title: 'No teams', description: 'This organization has no teams you can see.'}}>
      {(teams) => teams.map((team) => <Entry key={team.id} title={team.name} description={team.description} meta={team.permission}
        actions={<Button size="sm" onClick={() => { setSelected(selected === team.id ? undefined : team.id); }}>Members of {team.name}</Button>}/>)}
    </ResourceList>
    {selected !== undefined && <TeamMembers key={selected} id={selected} editable={editable}/>}
  </Panel>;
});

const TeamMembers = observer(function TeamMembers({id, editable}: {id: number; editable: boolean}) {
  const app = useApp();
  const offline = useOffline();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/teams/${String(id)}/members`;
  const res = useResource(`team:${String(id)}:members`, (signal) => allPages<Member>(app, base, signal));
  const change = async (login: string, method: 'PUT' | 'DELETE') => {
    setBusy(true);
    try {
      await online(app, {api: 'v1', method, path: `${base}/${encodeURIComponent(login)}`});
      res.reload();
      setOpen(false);
    } catch (err) {
      notify(app, {tone: 'danger', title: 'Team membership was not changed', description: failureText(err)});
    } finally { setBusy(false); }
  };
  const add = (u: FoundUser) => { void change(u.login, 'PUT'); };
  return <Panel label="Team members" title="Team members" actions={editable && <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button size="sm" disabled={offline || busy} tooltip={offline ? onlineOnly('Changing team membership') : undefined}>Add member</Button></PopoverTrigger>
    <PopoverContent width="md"><PeopleSearch excludeSelf={false} label="Add a team member" members={new Set((res.value ?? []).map((u) => u.id))} onPick={add} onClose={() => { setOpen(false); }}/></PopoverContent>
  </Popover>}>
    <ResourceList res={res} what="The members" empty={{icon: Users, title: 'No members', description: 'Add a person to this team.'}}>
      {(members) => members.map((u) => <Entry key={u.id} leading={<Avatar name={u.login} src={u.avatar_url}/>} title={u.full_name || u.login} meta={u.login}
        actions={editable && <IconButton icon={Trash2} label={offline ? onlineOnly('Changing team membership') : `Remove ${u.login} from team`} disabled={offline || busy} onClick={() => { void change(u.login, 'DELETE'); }}/>}/>)}
    </ResourceList>
  </Panel>;
});

export const RepositoryTeams = observer(function RepositoryTeams({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useOffline();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `${repoApi(owner, repo)}/teams`;
  const res = useResource(`settings:${String(repoId)}:teams`, (signal) => allPages<Team>(app, base, signal));
  const change = async (team: Team, method: 'PUT' | 'DELETE') => {
    setBusy(true);
    try {
      await online(app, {api: 'v1', method, path: `${base}/${encodeURIComponent(team.name)}`});
      res.reload();
      setOpen(false);
    } catch (err) {
      notify(app, {tone: 'danger', title: 'Team access was not changed', description: failureText(err)});
    } finally { setBusy(false); }
  };
  return <Panel label="Repository teams" title="Teams" actions={<Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button size="sm" disabled={offline || busy} tooltip={offline ? onlineOnly('Changing team access') : undefined}>Add team</Button></PopoverTrigger>
    <PopoverContent width="md">{open && <TeamPicker owner={owner} excluded={new Set((res.value ?? []).map((t) => t.id))} onPick={(t) => { void change(t, 'PUT'); }} onClose={() => { setOpen(false); }}/>}</PopoverContent>
  </Popover>}>
    <ResourceList res={res} what="The repository teams" empty={{icon: Users, title: 'No teams with access', description: 'Give an organization team access to this repository.'}}>
      {(teams) => teams.map((t) => <Entry key={t.id} title={t.name} meta={t.permission} actions={<IconButton icon={Trash2} label={offline ? onlineOnly('Changing team access') : `Remove team ${t.name}`} disabled={offline || busy} onClick={() => { void change(t, 'DELETE'); }}/>}/>)}
    </ResourceList>
  </Panel>;
});

function TeamPicker({owner, excluded, onPick, onClose}: {owner: string; excluded: ReadonlySet<number>; onPick: (t: Team) => void; onClose: () => void}) {
  const app = useApp();
  const res = useResource(`org:${owner}:teams`, (signal) => allPages<Team>(app, `/orgs/${encodeURIComponent(owner)}/teams`, signal));
  return <CommandPick label="Add a team" placeholder="Search teams…" empty={res.state === 'loading' ? 'Loading teams…' : res.error ?? 'No available teams.'} onClose={onClose}
    options={(res.value ?? []).filter((t) => !excluded.has(t.id)).map((t) => ({value: String(t.id), label: t.name, onSelect: () => { onPick(t); }}))}/>;
}
