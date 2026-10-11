// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A new organization (/org/create, a canonical route): a name checked as it
// is typed (against the pool at once, then Forgejo: users and organizations
// share names), the visibility, and whether repository admins may change
// which teams have access (the classic form's one permission). Online only
// (PLAN §5.4): API v1's POST /orgs; the organization's page opens once the
// pool holds it. Its own chunk.

import {useNavigate} from '@tanstack/react-router';
import {Building2, EyeOff, Globe, Users} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type SyntheticEvent, useState} from 'react';
import {onlineWrite} from '../../app/api.ts';
import {onlineOnly, reach} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Button, Callout, Checkbox, Input} from '../../ui/index.ts';
import {creationScope, newOrgRequest, ORG_NAME_MAX, orgNameProblem, orgRefusal, type OrgVisibility, type Refusal, scopeAllows} from './forms.ts';
import {loginTaken} from './owners.ts';
import {Choice, Field, hintOf, NameStatus, openWhenSynced, ScopeNote, Section, useAvailability} from './parts.tsx';

export const NewOrg = observer(function NewOrg() {
  const app = useApp();
  const session = useSession();
  const navigate = useNavigate();
  const isOnline = reach(session.data.status.connection) === 'online';
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [visibility, setVisibility] = useState<OrgVisibility>('public');
  const [teamAccess, setTeamAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal & {for: string} | undefined>(undefined);

  const trimmed = name.trim();
  const problem = orgNameProblem(trimmed);
  const takenHere = loginTaken(session.data.pool, trimmed);
  const availability = useAvailability(app, problem ? undefined : `/users/${encodeURIComponent(trimmed)}`, takenHere, isOnline);
  const refused = refusal?.for === trimmed ? refusal : undefined;
  const nameError = (touched || trimmed !== '') && problem ? problem :
    availability === 'taken' ? `“${trimmed}” is taken by a user or an organization.` :
      refused?.field === 'name' ? refused.text : undefined;
  const scope = creationScope(true);
  const scopeMissing = !scopeAllows(app.config.oauth?.scope, scope);
  const why = !isOnline ? onlineOnly('Creating an organization') :
    scopeMissing ? `Forgejo Next’s sign-in has no ${scope} scope: use the classic form.` :
    !trimmed ? 'Name the organization first.' : problem ?? (availability === 'taken' ? 'This name is taken.' : undefined);

  const create = (e?: SyntheticEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (busy || why) return;
    const req = newOrgRequest({name: trimmed, visibility, repoAdminChangeTeamAccess: teamAccess});
    setBusy(true);
    setRefusal(undefined);
    onlineWrite<{id?: unknown; name?: unknown; username?: unknown}>(app, {method: 'POST', api: 'v1', path: req.path, body: req.body}).then(async (made) => {
      const id = typeof made.value?.id === 'number' ? made.value.id : 0;
      const login = typeof made.value?.username === 'string' ? made.value.username : typeof made.value?.name === 'string' ? made.value.name : trimmed;
      const go = () => navigate({to: '/$owner', params: {owner: login}});
      if (id) await openWhenSynced(app, `org:${String(id)}`, made.syncId, go);
      else await go();
    }, (err: unknown) => {
      setBusy(false);
      setRefusal({...orgRefusal(err), for: trimmed});
    });
  };

  return (
    <>
      <PageHeader icon={Building2} title="New organization"/>
      <PageBody>
        <PageColumn>
          <form className="flex flex-col gap-4" noValidate onSubmit={create} onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) create(e);
          }}>
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-fg">Create a new organization</h2>
              <p className="text-base text-fg-muted">An organization owns repositories together: its members work in teams, each with its own access.</p>
            </div>
            {scopeMissing && <ScopeNote scope={scope} what="organizations" classic="/org/create"/>}

            <Field id="new-org-name" label="Organization name" required error={nameError}
              hint={<NameStatus availability={availability} free={`${trimmed} is available.`} idle="Letters, digits, “-”, “_” and “.”; it is the organization’s address."/>}>
              <Input id="new-org-name" className="w-full" autoFocus autoComplete="off" spellCheck={false} maxLength={ORG_NAME_MAX} value={name}
                invalid={Boolean(nameError)} aria-required aria-describedby={hintOf('new-org-name')}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                onBlur={() => {
                  if (name) setTouched(true);
                }}/>
            </Field>

            <Section title="Visibility">
              <Choice name="new-org-visibility" label="Visibility" value={visibility} onChange={setVisibility} options={[
                {value: 'public', label: 'Public', icon: Globe, description: 'Anyone can see the organization.'},
                {value: 'limited', label: 'Limited', icon: Users, description: 'Only signed-in users can see the organization.'},
                {value: 'private', label: 'Private', icon: EyeOff, description: 'Only its members can see the organization.'},
              ]}/>
            </Section>

            <Section title="Permissions">
              <div className="flex flex-col gap-1">
                <Checkbox label="Repository admins can add or remove the access of teams" checked={teamAccess} onChange={setTeamAccess}/>
                <p className="pl-6 text-sm text-fg-muted">Otherwise only the organization’s owners decide which teams have a repository. Which members may create repositories is up to each team.</p>
              </div>
            </Section>

            <Section>
              {refused?.field === 'form' && <Callout tone="danger" title="The organization was not created">{refused.text}</Callout>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {!isOnline && <span className="mr-auto text-sm text-fg-subtle">Offline: creating an organization needs a connection.</span>}
                <Button type="submit" variant="primary" shortcut={shortcutHint('submit')} tooltip={why ?? 'Create the organization'} aria-disabled={Boolean(why) || busy}>
                  {busy ? 'Creating…' : 'Create organization'}
                </Button>
              </div>
            </Section>
          </form>
        </PageColumn>
      </PageBody>
    </>
  );
});
