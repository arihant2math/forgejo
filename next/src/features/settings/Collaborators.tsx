// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's collaborators (/{owner}/{repo}/settings/collaboration):
// the pool's Collaboration rows paint the list at once (an administrator
// reads "write" there: the sync scope does not say who administers), API
// v1 then gives the exact roles (kept for the next visit). Adding someone
// (a people search), changing a role and removing apply at once and are
// undone if Forgejo refuses; removing offers Undo.

import {Trash2, UserPlus, Users} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import {
  Avatar, Badge, Button, CommandPick, Entry, FormSection, IconButton, Popover, PopoverContent, PopoverTrigger, type PickOption, Select, SegmentedControl,
} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ResourceList, useOffline} from './bits.tsx';
import {problemOf} from './problems.ts';
import {type FoundUser, fetchCollaborators, putCollaborator, removeCollaborator, searchUsers} from './requests.ts';
import {settingsKey, useResource} from './resource.ts';
import {byLogin, type Collaborator, type Role, roleOf, ROLES} from './rules.ts';

export const CollaboratorSettings = observer(function CollaboratorSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const pool = usePool();
  const offline = useOffline();
  const res = useResource(settingsKey(repoId, 'collaborators'), (signal) => fetchCollaborators(app, owner, repo, signal));
  // Before the first answer: the pool's rows (instant), with the role the pool knows.
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
      actions={<AddPerson disabled={offline} members={members} onAdd={add}/>}>
      <ResourceList res={shown} what="The collaborators" empty={{icon: Users, title: 'No collaborators', description: 'Add people to give them access to this repository.'}}>
        {(list) => list.map((c) => (
          <Entry key={c.id} leading={<Avatar name={c.login} src={c.avatar || undefined}/>} title={c.name} meta={c.name !== c.login ? c.login : undefined}
            description={c.approximate ? 'Checking the exact role…' : undefined}
            actions={<>
              <Select aria-label={`${c.login}’s role`} size="sm" value={c.role} disabled={offline} options={ROLES} onValueChange={(v) => {
                if (v !== c.role) setRole(c, v);
              }}/>
              <IconButton size="sm" icon={Trash2} label={`Remove ${c.login}`} disabled={offline} onClick={() => {
                remove(c);
              }}/>
            </>}/>
        ))}
      </ResourceList>
      {org && <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        Teams of the organization get access in the classic UI.
        <ClassicLink size="sm" to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/collaboration`}>Teams</ClassicLink>
      </p>}
    </FormSection>
  );
});

/** "Add people": a search over Forgejo's users (as you type), and the role they get. */
function AddPerson({disabled, members, onAdd}: {disabled: boolean; members: ReadonlySet<number>; onAdd: (u: FoundUser, role: Role) => void}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('write');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="sm" variant="primary" icon={UserPlus} disabled={disabled}>Add people</Button></PopoverTrigger>
      <PopoverContent width="md" align="end">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm text-fg-muted">Role</span>
          <SegmentedControl label="Role" value={role} onChange={setRole} options={ROLES}/>
        </div>
        <PeopleSearch members={members} onPick={(u) => {
          setOpen(false);
          onAdd(u, role);
        }} onClose={() => {
          setOpen(false);
        }}/>
      </PopoverContent>
    </Popover>
  );
}

function PeopleSearch({members, onPick, onClose}: {members: ReadonlySet<number>; onPick: (u: FoundUser) => void; onClose: () => void}) {
  const app = useApp();
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
  const options: PickOption[] = q && found.q === q ? found.users.filter((u) => u.id !== userId).map((u) => ({
    value: String(u.id), label: u.name, words: u.login, leading: <Avatar size="sm" name={u.login} src={u.avatar || undefined}/>,
    meta: members.has(u.id) ? <Badge>Collaborator</Badge> : u.name !== u.login ? u.login : undefined,
    onSelect: () => {
      if (!members.has(u.id)) onPick(u);
    },
  })) : [];
  const empty = !q ? 'Type a login or a name.' : found.q !== q ? 'Searching…' : found.error ?? 'Nobody by that name.';
  return <CommandPick label="Add a collaborator" placeholder="Search people…" options={options} empty={empty} onClose={onClose} query={query} onQueryChange={setQuery} filtered/>;
}
