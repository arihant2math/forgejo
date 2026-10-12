// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {useNavigate, useSearch} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {cloneElement, type SyntheticEvent, useEffect, useState} from 'react';
import {online, onlineWrite} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {onlineOnly, reach} from '../../app/online.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {Avatar, SegmentedControl} from '@primer/react';
import {FilteredSelect} from '../create/FilteredSelect.tsx';
import {
  creationScope, DESCRIPTION_MAX, initializes, newRepoRequest, REPO_NAME_MAX, repoNameProblem, repoRefusal, type Refusal, suggestName, TEMPLATE_ITEMS,
  scopeAllows, type TemplateItems, templateProblem,
} from './forms.ts';
import {type OwnerChoice, repoOwners, repoTaken, startsPrivate, templateRepos} from './owners.ts';
import {Choice, Field, hintOf, NamePicker, NameStatus, openWhenSynced, ScopeNote, Section, useAvailability} from './parts.tsx';
import {loadRepoTemplates, repoTemplates} from './templates.ts';
import {orgPermissions} from '../owner/permissions.ts';
import {RepoIcon, ChevronDownIcon, StackIcon, GlobeIcon, LockIcon} from '@primer/octicons-react';
import {Button, Checkbox, FormControl, TextInput} from '@primer/react';
import {Banner, Heading, Tooltip} from '@primer/react';

const FORMAT_LABELS: Record<string, string> = {sha1: 'SHA-1', sha256: 'SHA-256'};

const DEFAULT_ITEMS: TemplateItems = {git_content: true, topics: false, labels: false, webhooks: false, git_hooks: false, avatar: false, protected_branch: false};

export function NewRepo() {
  const search: {org?: string; template_id?: string} = useSearch({strict: false});
  const org = Number(search.org) || 0;
  const template = Number(search.template_id) || 0;
  return <NewRepoForm key={`${String(org)}:${String(template)}`} orgId={org} templateId={template}/>;
}

const NewRepoForm = observer(function NewRepoForm({orgId, templateId}: {orgId: number; templateId: number}) {
  const app = useApp();
  const session = useSession();
  const pool = session.data.pool;
  const {userId} = session;
  const navigate = useNavigate();
  const defaults = app.config.repository;
  const isOnline = reach(session.data.status.connection) === 'online';
  useEffect(() => {
    loadRepoTemplates(app);
  }, [app, isOnline]);
  const remote = useRemoteOwners(app, isOnline);
  const local = repoOwners(pool, userId);
  const owners = [...local, ...remote.filter((o) => !local.some((l) => l.id === o.id))];
  const templates = templateRepos(pool);

  const [ownerId, setOwnerId] = useState(orgId || userId);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [priv, setPriv] = useState(() => startsPrivate(pool, userId, defaults?.default_private, defaults?.force_private ?? false));
  const [template, setTemplate] = useState(() => (templates.some((t) => t.id === templateId) ? templateId : 0));
  const [items, setItems] = useState(DEFAULT_ITEMS);
  const [readme, setReadme] = useState(false);
  const [gitignores, setGitignores] = useState<string[]>([]);
  const [license, setLicense] = useState('');
  const [labels, setLabels] = useState('');
  const [branch, setBranch] = useState(defaults?.default_branch ?? '');
  const formats = defaults?.object_formats ?? [];
  const [format, setFormat] = useState(formats[0] ?? '');
  const [isTemplate, setIsTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal & {for: string} | undefined>(undefined);

  const owner: OwnerChoice | undefined = owners.find((o) => o.id === ownerId) ?? owners[0];
  const tpl = templates.find((t) => t.id === template);
  const trimmed = name.trim();
  const problem = repoNameProblem(trimmed);
  const takenHere = owner !== undefined && repoTaken(pool, owner.id, trimmed);
  const availability = useAvailability(app, owner && !problem ? `/repos/${encodeURIComponent(owner.login)}/${encodeURIComponent(trimmed)}` : undefined, takenHere, isOnline);
  const refused = refusal?.for === `${owner?.login ?? ''}/${trimmed}` ? refusal : undefined;
  const suggestion = problem && trimmed ? suggestName(trimmed) : '';
  const nameError = (touched || trimmed !== '') && problem ? `${problem}${suggestion && suggestion !== trimmed && !repoNameProblem(suggestion) ? ` Try “${suggestion}”.` : ''}` :
    availability === 'taken' ? `${owner?.login ?? 'This owner'} already has a repository named “${trimmed}”.` :
      refused?.field === 'name' ? refused.text : undefined;
  const init = initializes({readme, gitignores, license});
  const forced = defaults?.force_private ?? false;
  // Browser OAuth scopes may not permit creation for this owner; offer the classic form.
  const scope = creationScope(owner?.org ?? false);
  const scopeMissing = !scopeAllows(app.config.oauth?.scope, scope);
  const classicForm = `/repo/create${owner?.org ? `?org=${String(owner.id)}` : ''}`;
  const why = !isOnline ? onlineOnly('Creating a repository') :
    !owner ? 'Your account is not on this device yet.' :
      scopeMissing ? `Forgejo Next’s sign-in has no ${scope} scope: use the classic form.` :
      !trimmed ? 'Name the repository first.' :
        problem ?? (availability === 'taken' ? 'This name is taken.' : tpl ? templateProblem(items) : undefined);

  const create = (e?: SyntheticEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (busy || why || !owner) return;
    const req = newRepoRequest({
      owner: {login: owner.login, org: owner.org}, name: trimmed, description, private: priv || forced,
      template: tpl ? {owner: tpl.owner_name, name: tpl.name, items} : undefined,
      readme, gitignores, license, labels, defaultBranch: branch, objectFormat: formats.length > 1 ? format : '', isTemplate,
    });
    setBusy(true);
    setRefusal(undefined);
    onlineWrite<{id?: unknown; name?: unknown; owner?: {login?: unknown}}>(app, {method: 'POST', api: 'v1', path: req.path, body: req.body, timeout: 60_000}).then(async (made) => {
      const id = typeof made.value?.id === 'number' ? made.value.id : 0;
      const login = typeof made.value?.owner?.login === 'string' ? made.value.owner.login : owner.login;
      const repo = typeof made.value?.name === 'string' ? made.value.name : trimmed;
      const go = () => navigate({to: '/$owner/$repo', params: {owner: login, repo}});
      if (id) await openWhenSynced(app, `repo:${String(id)}`, made.syncId, go);
      else await go();
    }, (err: unknown) => {
      setBusy(false);
      setRefusal({...repoRefusal(err), for: `${owner.login}/${trimmed}`});
    });
  };

  return (
    <>
      <PageHeader icon={RepoIcon} title="New repository">
        <ClassicLink to="/repo/migrate" size="small">New migration</ClassicLink>
      </PageHeader>
      <PageBody>
        <PageColumn>
          <form className="flex flex-col gap-4" noValidate onSubmit={create} onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) create(e);
          }}>
            <div className="flex flex-col gap-1">
              <Heading as="h2" variant="medium">Create a new repository</Heading>
              <p className="text-base text-muted">
                A repository holds a project’s files and their history. Already have one elsewhere? Migrate it with “New migration”.
              </p>
              <p className="text-sm text-muted">Required fields are marked with an asterisk (*).</p>
            </div>
            {scopeMissing && <ScopeNote scope={scope} what={owner?.org ? `repositories in ${owner.login}` : 'repositories in your account'} classic={classicForm}/>}

            <Field id="new-repo-template" label="Repository template" hint="Start from a template repository’s files and settings.">
              <div className="flex">
                <FilteredSelect id="new-repo-template" title="Repository template" placeholderText="Start from the template…"
                  message={{title: 'No template repository is on this device.', body: '', variant: 'empty'}}
                  items={[{id: 0, text: 'No template'}, ...templates.map((t) => ({id: t.id, text: t.full_name, description: t.description, leadingVisual: StackIcon}))]}
                  selected={{id: template, text: tpl?.full_name ?? 'No template'}} onSelectedChange={(item) => { setTemplate(Number(item?.id ?? 0)); }}
                  renderAnchor={(props) => cloneElement(<Button type="button" id="new-repo-template" aria-describedby={hintOf('new-repo-template')} trailingVisual={ChevronDownIcon}>{tpl?.full_name ?? 'No template'}</Button>, props)}/>
              </div>
            </Field>

            <div className="flex flex-wrap items-start gap-2">
              <Field id="new-repo-owner" label="Owner" required>
                <OwnerPicker owners={owners} owner={owner} me={userId} onChange={setOwnerId}/>
              </Field>
              <span aria-hidden className="pt-7 text-xl text-muted">/</span>
              <div className="min-w-0 flex-1 basis-48">
                <Field id="new-repo-name" label="Repository name" required error={nameError}
                  hint={<NameStatus availability={availability} free={`${trimmed} is available.`} idle="Great repository names are short and memorable."/>}>
                  <TextInput id="new-repo-name" className="w-full" autoFocus autoComplete="off" spellCheck={false} maxLength={REPO_NAME_MAX} value={name} aria-required aria-describedby={hintOf('new-repo-name')} onChange={(e) => {
                      setName(e.target.value);
                    }} onBlur={() => {
                      if (name) setTouched(true);
                    }} {...(nameError ? {validationStatus: 'error' as const} : {})}/>
                </Field>
              </div>
            </div>
            <Field id="new-repo-description" label="Description" optional>
              <TextInput id="new-repo-description" className="w-full" maxLength={DESCRIPTION_MAX} value={description} onChange={(e) => {
                setDescription(e.target.value);
              }}/>
            </Field>

            <Section>
              <Choice name="new-repo-visibility" label="Visibility" value={priv || forced ? 'private' : 'public'} onChange={(v) => {
                setPriv(v === 'private');
              }} options={[
                {value: 'public', label: 'Public', icon: GlobeIcon, description: 'Anyone who can see the owner can see this repository. You choose who can commit.',
                  disabled: forced ? 'This instance makes every new repository private.' : undefined},
                {value: 'private', label: 'Private', icon: LockIcon, description: 'You choose who can see and commit to this repository.'},
              ]}/>
            </Section>

            {tpl ? (
              <Section title="Take from the template" description={`What ${tpl.full_name} passes on to the new repository.`}>
                <div className="flex flex-col gap-2">
                  {TEMPLATE_ITEMS.map((it) => (
                    <FormControl key={it.key}><Checkbox checked={items[it.key]} onChange={(event) => { const on = event.target.checked; setItems({...items, [it.key]: on}); }}/><FormControl.Label>{it.label}</FormControl.Label></FormControl>
                  ))}
                </div>
                {templateProblem(items) && <p className="text-sm text-danger">{templateProblem(items)}</p>}
              </Section>
            ) : (
              <InitSection readme={readme} setReadme={setReadme} gitignores={gitignores} setGitignores={setGitignores} license={license} setLicense={setLicense}/>
            )}

            <Section title="Advanced">
              {!tpl && (
                <Field id="new-repo-labels" label="Issue labels" optional hint="Start the issue tracker with one of Forgejo’s label sets.">
                  <div className="flex">
                    <NamePicker id="new-repo-labels" label="Issue labels" placeholder="Choose a label set…" names={repoTemplates.get()?.labels ?? []}
                      chosen={labels ? [labels] : []} none="No labels" empty={isOnline ? 'Loading the label sets…' : 'The label sets load when you are online.'}
                      onChange={(n) => {
                        setLabels(n[0] ?? '');
                      }}/>
                  </div>
                </Field>
              )}
              <Field id="new-repo-branch" label="Default branch" hint={tpl ? 'The branch the template’s default branch becomes.' : init ? 'The branch of the first commit.' : 'The branch the repository expects first.'}>
                <TextInput id="new-repo-branch" className="w-64" autoComplete="off" spellCheck={false} maxLength={100} value={branch} placeholder={defaults?.default_branch ?? 'main'} aria-describedby={hintOf('new-repo-branch')} onChange={(e) => {
                    setBranch(e.target.value);
                  }}/>
              </Field>
              {!tpl && formats.length > 1 && (
                <div className="flex flex-col gap-1">
                  <span className="text-base font-semibold text-default">Object format</span>
                  <div className="flex"><SegmentedControl aria-label="Object format" onChange={(index) => { setFormat(formats[index] ?? ''); }}>
                    {formats.map((f) => <SegmentedControl.Button key={f} selected={format === f}>{FORMAT_LABELS[f] ?? f}</SegmentedControl.Button>)}
                  </SegmentedControl></div>
                  <p className="text-sm text-muted">How Git names objects. SHA-256 cannot be changed later, and some tools do not support it yet.</p>
                </div>
              )}
              {!tpl && <FormControl><Checkbox checked={isTemplate} onChange={(event) => { setIsTemplate(event.target.checked); }}/><FormControl.Label>Make this repository a template</FormControl.Label></FormControl>}
            </Section>

            <Section>
              {owner && (
                <p className="text-sm text-muted">
                  {`You are creating a ${priv || forced ? 'private' : 'public'} repository ${owner.org ? `in the organization ${owner.login}` : 'in your personal account'}.`}
                </p>
              )}
              {refused?.field === 'form' && <Banner variant="critical" title="The repository was not created" description={refused.text}/>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {!isOnline && <span className="mr-auto text-sm text-muted">Offline: creating a repository needs a connection.</span>}
                {/* aria-disabled, not disabled: the tooltip says what is missing (offline, a name). */}
                <Tooltip text={why ?? 'Create the repository'} keybindingHint={shortcutHint('submit')}><Button variant="primary" type="submit" inactive={Boolean(why) || busy}>
                  {busy ? 'Creating…' : 'Create repository'}
                </Button></Tooltip>
              </div>
            </Section>
          </form>
        </PageColumn>
      </PageBody>
    </>
  );
});

const InitSection = observer(function InitSection({readme, setReadme, gitignores, setGitignores, license, setLicense}: {
  readme: boolean; setReadme: (on: boolean) => void; gitignores: string[]; setGitignores: (v: string[]) => void; license: string; setLicense: (v: string) => void;
}) {
  const lists = repoTemplates.get();
  const loading = lists ? '' : 'Loading the templates…';
  // Forgejo writes the README in the same first commit as a .gitignore or a license.
  const implied = gitignores.length > 0 || license !== '';
  return (
    <Section title="Initialize this repository with" description="Skip this to push an existing repository.">
      <div className="flex flex-col gap-1">
        <FormControl disabled={implied}><Checkbox checked={readme || implied} onChange={(event) => { setReadme(event.target.checked); }}/><FormControl.Label>Add a README file</FormControl.Label></FormControl>
        <p className="pl-6 text-sm text-muted">
          {implied ? 'Forgejo adds a README with a .gitignore or a license.' : 'A long description of the project, shown on its home.'}
        </p>
      </div>
      <Field id="new-repo-gitignore" label="Add .gitignore" hint="Files Git does not track, from a list of templates (several combine).">
        <div className="flex">
          <NamePicker id="new-repo-gitignore" label=".gitignore templates" placeholder="Filter the templates…" names={lists?.gitignores ?? []} chosen={gitignores} multi
            none="No .gitignore" empty={loading || 'Forgejo has no .gitignore templates.'} onChange={setGitignores}/>
        </div>
      </Field>
      <Field id="new-repo-license" label="Choose a license" hint="What others may and may not do with the code.">
        <div className="flex">
          <NamePicker id="new-repo-license" label="Licenses" placeholder="Filter the licenses…" names={lists?.licenses ?? []} chosen={license ? [license] : []}
            none="No license" empty={loading || 'Forgejo has no license templates.'} onChange={(n) => {
              setLicense(n[0] ?? '');
            }}/>
        </div>
      </Field>
    </Section>
  );
});

export function OwnerPicker({owners, owner, me, onChange}: {owners: OwnerChoice[]; owner: OwnerChoice | undefined; me: number; onChange: (id: number) => void}) {
  return (
    <FilteredSelect id="new-repo-owner" title="Owner" placeholder="Owner" placeholderText="Create for…"
      message={{title: 'Your account is not on this device yet.', body: '', variant: 'empty'}}
      items={owners.map((o) => ({
        id: o.id, text: o.id === me ? `${o.login} (you)` : o.login, description: o.name,
        leadingVisual: () => <Avatar size={20} alt={o.login} src={o.avatar}/>,
      }))}
      selected={owner ? {id: owner.id, text: owner.login} : undefined}
      onSelectedChange={(item) => { if (item) onChange(Number(item.id)); }}
      renderAnchor={(props) => cloneElement(<Button type="button" id="new-repo-owner" trailingVisual={ChevronDownIcon}>
        {owner ? <><Avatar size={20} alt={owner.login} src={owner.avatar}/>{owner.login}</> : 'Owner'}
      </Button>, props)}/>
  );
}

interface ApiOrg {
  id: number;
  username?: string;
  name?: string;
  full_name?: string;
  avatar_url?: string;
}

/** Fetch creatable owners absent from the pool, including unsynced teams and administrator access. */
export function useRemoteOwners(app: App, isOnline: boolean): OwnerChoice[] {
  const session = app.session;
  const [owners, setOwners] = useState<OwnerChoice[]>([]);
  useEffect(() => {
    if (!session || !isOnline) return undefined;
    const ctl = new AbortController();
    const signal = ctl.signal;
    const me = session.data.pool.model('User').get(session.userId)?.data.login;
    void (async () => {
      const orgs = await online<ApiOrg[]>(app, {api: 'v1', path: '/user/orgs?limit=50', signal});
      if (!orgs || !me) return;
      const known = new Set(repoOwners(session.data.pool, session.userId).map((o) => o.id));
      const asked = await Promise.all(orgs.filter((o) => !known.has(o.id)).map(async (o) => {
        const login = o.username ?? o.name ?? '';
        const p = await orgPermissions(app, login, me).catch(() => undefined);
        return p?.can_create_repository || p?.is_owner ? {id: o.id, login, name: o.full_name ?? '', avatar: o.avatar_url ?? '', org: true} : undefined;
      }));
      if (!signal.aborted) setOwners(asked.filter((o): o is OwnerChoice => o !== undefined));
    })().catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [app, session, isOnline]);
  return owners;
}
