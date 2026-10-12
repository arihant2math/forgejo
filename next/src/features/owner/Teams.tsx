// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ResourceSection, PersonRow} from '../repo/layout.tsx';
import {Avatar, Button, Dialog, SelectPanel, Banner, Tooltip, type SelectPanelItemInput} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly, useReach} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {PeopleSearch} from '../settings/Collaborators.tsx';
import {ResourceList} from '../settings/bits.tsx';
import {allPages, type FoundUser, repoApi} from '../settings/requests.ts';
import {useResource} from '../../app/resource.ts';
import {useOrgPermissions} from './permissions.ts';
import {TrashIcon, PeopleIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Button as PrimerButton, IconButton} from '@primer/react';
import {PrimaryLink} from '../../app/routerLinks.tsx';

interface Team {id: number; name: string; description: string; permission: string; includes_all_repositories?: boolean}
interface Member {id: number; login: string; full_name: string; avatar_url: string}

export const OrganizationTeams = observer(function OrganizationTeams({owner}: {owner: string}) {
  const app = useApp();
  const perms = useOrgPermissions(owner);
  const editable = perms.fresh && (perms.value?.is_owner === true || perms.value?.is_admin === true);
  const res = useResource(`org:${owner}:teams`, (signal) => allPages<Team>(app, `/orgs/${encodeURIComponent(owner)}/teams`, signal));
  const [selected, setSelected] = useState<number>();
  return <ResourceSection label="Teams" title="Teams">
    <ResourceList res={res} what="The teams" empty={{icon: PeopleIcon, title: 'No teams', description: 'This organization has no teams you can see.'}}>
      {(teams) => teams.map((team) => <PersonRow key={team.id} title={team.name} meta={team.permission}
        description={<>{team.description && <p>{team.description}</p>}<TeamRepos team={team}/></>}
        actions={<PrimerButton size="small" type="button" onClick={() => { setSelected(selected === team.id ? undefined : team.id); }}>Members of {team.name}</PrimerButton>}/>)}
    </ResourceList>
    {selected !== undefined && <TeamMembers key={selected} id={selected} editable={editable}/>}
  </ResourceSection>;
});

/** API v1 exposes all members to members, public members to others; removal affects every team. */
export const OrganizationPeople = observer(function OrganizationPeople({owner}: {owner: string}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const perms = useOrgPermissions(owner);
  const manage = perms.fresh && perms.value?.is_owner === true;
  const path = `/orgs/${encodeURIComponent(owner)}/members`;
  const res = useResource(`profile-people:${path}`, (signal) => allPages<Member>(app, path, signal));
  const [removing, setRemoving] = useState<Member>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async (m: Member) => {
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {api: 'v1', method: 'DELETE', path: `${path}/${encodeURIComponent(m.login)}`});
      setRemoving(undefined);
      res.reload();
      notify(app, {tone: 'success', title: `Removed ${m.login} from ${owner}`});
    } catch (err) {
      setError(failureText(err));
    } finally { setBusy(false); }
  };
  return <ResourceSection label="People" title="People">
    <ResourceList res={res} what="The people" empty={{icon: PeopleIcon, title: 'No people to show', description: 'None that you can see.'}}>
      {(people) => people.map((m) => <PersonRow key={m.id} leading={<Avatar size={20} alt={m.login} src={m.avatar_url}/>}
        title={<PrimaryLink to="/$owner" params={{owner: m.login}}>{m.full_name || m.login}</PrimaryLink>} meta={m.full_name ? m.login : undefined}
        actions={manage && <ActionMenu>
          <ActionMenu.Anchor><IconButton size="small" icon={KebabHorizontalIcon} variant="invisible" aria-label={`Member options for ${m.login}`} type="button"/></ActionMenu.Anchor>
          <ActionMenu.Overlay align="end"><ActionList>
            <ActionList.Item variant="danger" disabled={busy} {...(offline ? {inactiveText: onlineOnly('Removing a member')} : {})} onSelect={() => {
              setError(undefined);
              setRemoving(m);
            }}>Remove from organization…</ActionList.Item>
          </ActionList></ActionMenu.Overlay>
        </ActionMenu>}/>)}
    </ResourceList>
    {manage && <p className="px-4 py-2 text-sm text-muted">People join the organization through its teams (Teams: add a member).</p>}
    {removing && <Dialog title={`Remove ${removing.login} from ${owner}?`} subtitle="They leave every team of the organization and lose the access those teams gave them." onClose={() => { if (!busy) setRemoving(undefined); }} footerButtons={[{content: 'Cancel', disabled: busy, onClick: () => { setRemoving(undefined); }}, {content: 'Remove from organization', buttonType: 'danger', disabled: busy || offline, onClick: () => { void remove(removing); }}]}>{error && <Banner variant="critical" title="Could not remove member" description={error}/>}</Dialog>}
  </ResourceSection>;
});

export const TeamRepos = observer(function TeamRepos({team}: {team: Team}) {
  const app = useApp();
  const all = team.includes_all_repositories === true;
  const res = useResource(`team:${String(team.id)}:repos`, (signal) => (all ? Promise.resolve([]) : allPages<{id: number; full_name: string; name: string}>(app, `/teams/${String(team.id)}/repos`, signal)));
  if (all) return <p>All repositories of the organization</p>;
  // Only owners and team members can list repositories; absence is not an empty list.
  if (!res.value) return null;
  if (!res.value.length) return <p>No repositories</p>;
  const names = res.value.slice(0, 10).map((r) => r.name).join(', ');
  const more = res.value.length - 10;
  return <p>{res.value.length === 1 ? 'Repository' : `${String(res.value.length)} repositories`}: {names}{more > 0 ? ` and ${String(more)} more` : ''}</p>;
});

const TeamMembers = observer(function TeamMembers({id, editable}: {id: number; editable: boolean}) {
  const app = useApp();
  const offline = useReach() !== 'online';
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
  return <ResourceSection label="Team members" title="Team members" actions={editable && <><Tooltip text={offline ? onlineOnly('Changing team membership') : 'Add a team member'}><Button size="small" inactive={offline} disabled={busy} onClick={() => { setOpen(true); }}>Add member</Button></Tooltip>{open && <PeopleSearch excludeSelf={false} label="Add a team member" members={new Set((res.value ?? []).map((u) => u.id))} onPick={add} onClose={() => { setOpen(false); }}/>}</>}>
    <ResourceList res={res} what="The members" empty={{icon: PeopleIcon, title: 'No members', description: 'Add a person to this team.'}}>
      {(members) => members.map((u) => <PersonRow key={u.id} leading={<Avatar size={20} alt={u.login} src={u.avatar_url}/>} title={u.full_name || u.login} meta={u.login}
        actions={editable && <IconButton size="small" icon={TrashIcon} variant="invisible" aria-label={offline ? onlineOnly('Changing team membership') : `Remove ${u.login} from team`} type="button" disabled={offline || busy} onClick={() => { void change(u.login, 'DELETE'); }}/>}/>)}
    </ResourceList>
  </ResourceSection>;
});

export const RepositoryTeams = observer(function RepositoryTeams({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useReach() !== 'online';
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
  return <ResourceSection label="Repository teams" title="Teams" actions={<TeamPicker owner={owner} open={open} onOpenChange={setOpen} disabled={offline || busy} excluded={new Set((res.value ?? []).map((t) => t.id))} onPick={(t) => { void change(t, 'PUT'); }}/>}>
    <ResourceList res={res} what="The repository teams" empty={{icon: PeopleIcon, title: 'No teams with access', description: 'Give an organization team access to this repository.'}}>
      {(teams) => teams.map((t) => <PersonRow key={t.id} title={t.name} meta={t.permission} actions={<IconButton size="small" icon={TrashIcon} variant="invisible" aria-label={offline ? onlineOnly('Changing team access') : `Remove team ${t.name}`} type="button" disabled={offline || busy} onClick={() => { void change(t, 'DELETE'); }}/>}/>)}
    </ResourceList>
  </ResourceSection>;
});

function TeamPicker({owner, excluded, onPick, open, onOpenChange, disabled}: {owner: string; excluded: ReadonlySet<number>; onPick: (t: Team) => void; open: boolean; onOpenChange: (open: boolean) => void; disabled: boolean}) {
  const app = useApp();
  const [filter, setFilter] = useState('');
  const res = useResource(`org:${owner}:teams`, (signal) => allPages<Team>(app, `/orgs/${encodeURIComponent(owner)}/teams`, signal));
  const teams = (res.value ?? []).filter((t) => !excluded.has(t.id));
  return <SelectPanel open={open} onOpenChange={onOpenChange} renderAnchor={(props) => <Button {...{...props}} size="small" disabled={disabled}>Add team</Button>} title="Add a team" placeholderText="Search teams…" filterValue={filter} onFilterChange={setFilter} selected={undefined}
    items={teams.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())).map((t) => ({id: t.id, text: t.name}))}
    onSelectedChange={(item: SelectPanelItemInput | undefined) => { if (item && !Array.isArray(item)) { const id = item.id; const team = teams.find((t) => String(t.id) === String(id)); if (team) onPick(team); } }}/>
}

