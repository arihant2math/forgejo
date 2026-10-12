// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {repoGroup} from '../../data/models.ts';
import {apiRepoPath} from '../../app/paths.ts';
import {useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {online, onlineWrite} from '../../app/api.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {DESCRIPTION_MAX, REPO_NAME_MAX, repoNameProblem, repoRefusal} from '../new/forms.ts';
import {OwnerPicker, useRemoteOwners} from '../new/NewRepo.tsx';
import {repoOwners, repoTaken} from '../new/owners.ts';
import {NameStatus, openWhenSynced, useAvailability} from '../new/parts.tsx';
import {Field} from '../../components/Field.tsx';
import {RepoForkedIcon} from '@primer/octicons-react';
import {Banner, Button, Checkbox, FormControl, Dialog, TextInput, Tooltip} from '@primer/react';

interface Fork {id: number; name: string; owner: {login: string}}

export const ForkButton = observer(function ForkButton({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const session = useSession();
  const source = session.data.pool.model('Repository').get(repoId)?.data;
  const [open, setOpen] = useState(false);
  const isOnline = reach(session.data.status.connection) === 'online';
  return <>
    <Tooltip text={!isOnline ? onlineOnly('Forking a repository') : 'Fork your own copy of this repository'}><Button count={source?.forks_count ?? 0} leadingVisual={RepoForkedIcon} size="small" type="button" inactive={!isOnline} onClick={() => { setOpen(true); }}>
      Fork
    </Button></Tooltip>
    {open && <ForkForm owner={owner} repo={repo} repoId={repoId} close={() => { setOpen(false); }}/>}
  </>;
});

const ForkForm = observer(function ForkForm({owner: sourceOwner, repo, repoId, close}: {owner: string; repo: string; repoId: number; close: () => void}) {
  const app = useApp();
  const session = useSession();
  const navigate = useNavigate();
  const pool = session.data.pool;
  const source = pool.model('Repository').get(repoId)?.data;
  const isOnline = reach(session.data.status.connection) === 'online';
  const remote = useRemoteOwners(app, isOnline);
  const local = repoOwners(pool, session.userId);
  const owners = [...local, ...remote.filter((o) => !local.some((l) => l.id === o.id))];
  const [ownerId, setOwnerId] = useState(session.userId);
  const owner = owners.find((o) => o.id === ownerId);
  const [name, setName] = useState(repo);
  const [description, setDescription] = useState(source?.description ?? '');
  const [defaultOnly, setDefaultOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState<Fork>();
  const [checking, setChecking] = useState(true);
  const trimmed = name.trim();
  const problem = repoNameProblem(trimmed);
  const path = `${apiRepoPath(sourceOwner, repo)}/forks`;
  const availability = useAvailability(app, owner && !problem ? apiRepoPath(owner.login, trimmed) : undefined, !!owner && repoTaken(pool, owner.id, trimmed), isOnline);
  const ownerLogin = owner?.login;
  useEffect(() => {
    const ctl = new AbortController();
    setExisting(undefined);
    setChecking(true);
    if (!isOnline || !ownerLogin) return () => { ctl.abort(); };
    void (async () => {
      for (let page = 1; ; page++) {
        const forks = await online<Fork[]>(app, {api: 'v1', path: `${path}?limit=50&page=${String(page)}`, signal: ctl.signal});
        const found = forks?.find((f) => f.owner.login.toLowerCase() === ownerLogin.toLowerCase());
        if (found) { if (!ctl.signal.aborted) setExisting(found); break; }
        if (!forks || forks.length < 50) break;
      }
      if (!ctl.signal.aborted) setChecking(false);
    })().catch(() => { if (!ctl.signal.aborted) { setChecking(false); setError('Could not check for an existing fork. Try again.'); } });
    return () => { ctl.abort(); };
  }, [app, path, ownerLogin, isOnline]);
  const why = !isOnline ? onlineOnly('Forking a repository') : !owner ? 'Choose an owner.' : checking ? 'Checking for an existing fork…' : existing ? undefined : problem ?? (availability === 'taken' ? 'This name is taken.' : undefined);
  const openFork = async (fork: Fork, syncId?: number) => {
    await openWhenSynced(app, repoGroup(fork.id), syncId, () => navigate({to: '/$owner/$repo', params: {owner: fork.owner.login, repo: fork.name}}));
    close();
  };
  const create = async () => {
    if (busy || why || !owner) return;
    setBusy(true);
    setError('');
    try {
      if (existing) { await openFork(existing); return; }
      const made = await onlineWrite<Fork>(app, {method: 'POST', api: 'v1', path, timeout: 60_000, body: {
        name: trimmed, description, default_branch_only: defaultOnly, ...(owner.org ? {organization: owner.login} : {}),
      }});
      if (!made.value) throw new Error('Forgejo did not return the new fork.');
      await openFork(made.value, made.syncId);
    } catch (err) { setError(repoRefusal(err).text); setBusy(false); }
  };
  return <Dialog title="Create a new fork" subtitle={`A copy of ${sourceOwner}/${repo}, with its own changes.`} width="xlarge" onClose={() => { if (!busy) close(); }} footerButtons={[{content: 'Cancel', disabled: busy, onClick: close}, {content: existing ? 'Open existing fork' : busy ? 'Creating fork…' : 'Create fork', buttonType: 'primary', disabled: busy || Boolean(why), onClick: () => { void create(); }}]}>
    {why && <p className="mb-3 text-muted">{why}</p>}
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <Field label="Owner" required><OwnerPicker owners={owners} owner={owner} me={session.userId} onChange={setOwnerId}/></Field>
      {existing ? <Banner title="Existing fork" description={`You already have a fork: ${existing.owner.login}/${existing.name}. Open it instead.`}/> : <>
        <Field label="Repository name" required error={problem ?? (availability === 'taken' ? 'This name is taken.' : undefined)} hint={<NameStatus availability={availability} free={`${trimmed} is available.`} idle="Choose a name for your fork."/>}>
          <TextInput className="w-full" value={name} maxLength={REPO_NAME_MAX} onChange={(e) => { setName(e.target.value); }}/>
        </Field>
        <Field label="Description" optional><TextInput className="w-full" value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => { setDescription(e.target.value); }}/></Field>
        <FormControl><Checkbox checked={defaultOnly} onChange={(event) => { setDefaultOnly(event.target.checked); }}/><FormControl.Label>Copy the default branch only</FormControl.Label></FormControl>
      </>}
      {error && <Banner variant="critical" title="Could not fork" description={error}/>}
    </form>
  </Dialog>;
});
