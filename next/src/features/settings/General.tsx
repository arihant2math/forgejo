// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {RepositoryConfirmation} from './RepositoryConfirmation.tsx';
import {FormSection, SettingRow} from '../usersettings/form.tsx';
import {Banner, BranchName, ToggleSwitch, Select, Button, IconButton, TextInput, FormControl, Textarea} from '@primer/react';


import {useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import type {Repository} from '../../protocol/types.gen.ts';
import {LocalSelectPanel} from '../../components/LocalSelectPanel.tsx';
import {refTable} from '../code/hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {sendChange, useOptimistic} from './bits.tsx';
import {useReach} from '../../app/online.ts';
import {
  defaultStyleChoices, type Details, detailsOf, detailsPatch, FEATURES, type Feature, featureState, type FieldErrors, type MergeStyle,
  mergeStyleToggle, MERGE_STYLES, newOwnerOf, type PullSettings, pullSettingsOf, type RepoPatch, sameDetails, validateDetails,
} from './forms.ts';
import {problemOf} from './problems.ts';
import {deleteRepo, patchRepo, transferRepo} from './requests.ts';
import {ArrowSwitchIcon} from '@primer/octicons-react';

export const GeneralSettings = observer(function GeneralSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const pool = usePool();
  const r = pool.model('Repository').get(repoId)?.data;
  if (!r) return null;
  const rows = [...pool.model('RepoUnit').by('repo_id', repoId)];
  const units = new Set(rows.map((u) => u.get('type')));
  const pulls = rows.find((u) => u.get('type') === 'pulls')?.data.config;
  return (
    <>
      {r.archived && <Banner variant="warning" title="This repository is archived" description={<>It is read-only. Unarchive it in the danger zone below to change it again.</>}/>}
      <DetailsForm owner={owner} repo={repo} r={r}/>
      <DefaultBranch owner={owner} repo={repo} r={r}/>
      <Features owner={owner} repo={repo} r={r} units={units}/>
      {pulls && <PullRequests owner={owner} repo={repo} config={pulls}/>}
      <DangerZone owner={owner} repo={repo} r={r}/>
    </>
  );
});

const DETAIL_FIELDS: Record<string, keyof Details> = {name: 'name', 'repo name': 'name', description: 'description', website: 'website'};

const DetailsForm = observer(function DetailsForm({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const navigate = useNavigate();
  const offline = useReach() !== 'online';
  const fresh = detailsOf(r);
  const [base, setBase] = useState(fresh);
  const [form, setForm] = useState(fresh);
  // Preserve the saved form until sync catches up.
  const [expect, setExpect] = useState<Details | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors<keyof Details>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (expect && sameDetails(fresh, expect)) setExpect(undefined);
  // Follow pool changes only while the form is untouched.
  if (!sameDetails(fresh, base) && sameDetails(form, base) && (!expect || sameDetails(fresh, expect))) {
    setBase(fresh);
    setForm(fresh);
  }
  const patch = detailsPatch(base, form);
  const dirty = Object.keys(patch).length > 0;
  const edit = (k: keyof Details, v: string) => {
    setForm({...form, [k]: v});
    if (errors[k]) setErrors({...errors, [k]: undefined});
  };
  const save = async () => {
    if (offline || busy) return;
    const errs = validateDetails(form);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean)) {
      document.getElementById(`repo-${Object.keys(errs).find((k) => errs[k as keyof Details]) ?? 'name'}`)?.focus();
      return;
    }
    if (!dirty) return;
    setBusy(true);
    try {
      const res = await patchRepo(app, owner, repo, patch);
      const saved: Details = {...base, ...patch};
      setBase(saved);
      setForm(saved);
      setExpect(saved);
      notify(app, {tone: 'success', title: patch.name ? `Renamed to ${patch.name}` : 'Settings saved'});
      if (patch.name) void navigate({to: '/$owner/$repo/settings', params: {owner, repo: res?.name ?? patch.name}, replace: true});
    } catch (err) {
      const p = problemOf(err, DETAIL_FIELDS);
      if (p.field) setErrors({[p.field]: p.message});
      else setFailure(p.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSection id="settings-details" title="General">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <FormControl id="repo-name"><FormControl.Label>Repository name</FormControl.Label>
          <TextInput className="w-full" value={form.name} maxLength={100} autoComplete="off" spellCheck={false} onChange={(e) => {
              edit('name', e.target.value);
            }} {...(errors.name ? {validationStatus: 'error' as const} : {})}/>
        {form.name.trim() !== base.name && <FormControl.Caption>Renaming changes its address; Forgejo redirects the old one.</FormControl.Caption>}{errors.name && <FormControl.Validation variant="error">{errors.name}</FormControl.Validation>}</FormControl>
        <FormControl id="repo-description"><FormControl.Label>Description</FormControl.Label>
          <Textarea rows={3} value={form.description} onChange={(e) => {
              edit('description', e.target.value);
            }} block {...(errors.description ? {validationStatus: 'error' as const} : {})}/>
        {errors.description && <FormControl.Validation variant="error">{errors.description}</FormControl.Validation>}</FormControl>
        <FormControl id="repo-website"><FormControl.Label>Website</FormControl.Label>
          <TextInput type="url" className="w-full" placeholder="https://" value={form.website} onChange={(e) => {
              edit('website', e.target.value);
            }} {...(errors.website ? {validationStatus: 'error' as const} : {})}/>
        {errors.website && <FormControl.Validation variant="error">{errors.website}</FormControl.Validation>}</FormControl>
        {failure && <Banner variant="critical" title="Not saved" description={<>{failure}</>}/>}
        <div className="flex items-center gap-2">
          <Button size="small" variant="primary" type="submit" disabled={!dirty || busy || offline}>{busy ? 'Saving…' : 'Save changes'}</Button>
          {dirty && <Button size="small" variant="invisible" type="button" disabled={busy} onClick={() => {
            setForm(base);
            setErrors({});
            setFailure(undefined);
          }}>Discard</Button>}
        </div>
      </form>
    </FormSection>
  );
});

const DefaultBranch = observer(function DefaultBranch({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const pool = usePool();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const offline = useReach() !== 'online';
  const opt = useOptimistic(r.default_branch);
  return (
    <FormSection id="settings-branch" title="Default branch" description="The branch the repository opens on, and the base of new pull requests.">
      <div className="flex items-center gap-2">
        {opt.shown ? <BranchName as="span">{opt.shown}</BranchName> : <span className="text-muted">None</span>}
        <LocalSelectPanel title="Switch default branch" placeholder="Find a branch…"
          empty={r.empty ? 'This repository has no branches yet.' : 'No branches on this device yet.'}
          options={refTable(pool, r.id).branchNames.map((b) => ({value: b, label: b, checked: b === opt.shown, onSelect: () => {
            if (b !== opt.shown) setPicked(b);
          }}))}
          renderAnchor={(props) => <IconButton {...props} size="small" icon={ArrowSwitchIcon} disabled={offline || r.archived} aria-label="Switch to another branch"/>}/>
      </div>
      <RepositoryConfirmation open={picked !== undefined} onOpenChange={(o) => { if (!o) setPicked(undefined); }} title={`Switch the default branch to ${picked ?? ''}?`}
        description="Changing your default branch can have unintended consequences that can affect new pull requests and clones."
        confirmLabel="I understand, update the default branch." onConfirm={() => {
          if (picked === undefined || offline) return;
          const branch = picked;
          setPicked(undefined);
          sendChange(app, opt, branch, 'The default branch', () => patchRepo(app, owner, repo, {default_branch: branch}), `The default branch is ${branch}`);
        }}/>
    </FormSection>
  );
});

function Features({owner, repo, r, units}: {owner: string; repo: string; r: Repository; units: ReadonlySet<string>}) {
  return (
    <FormSection id="settings-features" title="Features" description="What this repository offers. Turning one off hides it; its content is kept.">
      <div className="flex flex-col">
        {FEATURES.map((f) => <FeatureRow key={f.key} owner={owner} repo={repo} feature={f} state={featureState(units, f)} archived={r.archived}/>)}
        <FlagRow owner={owner} repo={repo} id="repo-template" title="Template repository" field="template" value={r.template} archived={r.archived}
          description="Others can generate new repositories with this one’s files and settings."/>
      </div>
    </FormSection>
  );
}

const FeatureRow = observer(function FeatureRow({owner, repo, feature: f, state, archived}: {owner: string; repo: string; feature: Feature; state: {on: boolean; external: boolean}; archived: boolean}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const opt = useOptimistic(state.on);
  const id = `feature-${f.unit}`;
  const description = state.external ? `${f.description} It uses an external ${f.unit === 'wiki' ? 'wiki' : 'tracker'}: change that in the classic UI (Units).` : f.description;
  return (
    <SettingRow id={id} title={f.label} description={description}>
      <ToggleSwitch size="small" aria-labelledby={`${id}-label`} checked={opt.shown} disabled={offline || state.external || archived} aria-describedby={`${id}-description`} onChange={(on) => {
        sendChange(app, opt, on, f.label, () => patchRepo(app, owner, repo, {[f.key]: on}));
      }}/>
      </SettingRow>
  );
});

const FlagRow = observer(function FlagRow({owner, repo, id, title, description, field, value, archived}: {
  owner: string; repo: string; id: string; title: string; description: string; field: 'template'; value: boolean; archived: boolean;
}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const opt = useOptimistic(value);
  return (
    <SettingRow id={id} title={title} description={description}>
      <ToggleSwitch size="small" aria-labelledby={`${id}-label`} checked={opt.shown} disabled={offline || archived} aria-describedby={`${id}-description`} onChange={(on) => {
        sendChange(app, opt, on, title, () => patchRepo(app, owner, repo, {[field]: on}));
      }}/>
      </SettingRow>
  );
});

const PullRequests = observer(function PullRequests({owner, repo, config}: {owner: string; repo: string; config: Record<string, unknown>}) {
  const app = useApp();
  const offline = useReach() !== 'online';
  const opt = useOptimistic<PullSettings>(pullSettingsOf(config));
  const s = opt.shown;
  const apply = (next: PullSettings, patch: RepoPatch, what: string) => {
    sendChange(app, opt, next, what, () => patchRepo(app, owner, repo, patch));
  };
  const toggle = (style: MergeStyle, on: boolean) => {
    const res = mergeStyleToggle(s, style, on);
    if ('error' in res) {
      notify(app, {tone: 'warning', title: res.error});
      return;
    }
    apply({...s, allowed: {...s.allowed, [style]: on}, defaultStyle: res.patch.default_merge_style ?? s.defaultStyle}, res.patch, 'The merge styles');
  };
  const flag = (key: 'deleteBranch' | 'rebaseUpdate' | 'maintainerEdit', field: keyof RepoPatch, on: boolean, what: string) => {
    apply({...s, [key]: on}, {[field]: on}, what);
  };
  return (
    <FormSection id="settings-pulls" title="Pull requests" description="How pull requests can be merged, and what a new one starts with.">
      <div className="flex flex-col">
        {MERGE_STYLES.map((m) => (
          <SettingRow key={m.style} id={`merge-${m.style}`} title={m.label} description={m.description}>
            <ToggleSwitch size="small" aria-labelledby={`merge-${m.style}-label`} checked={s.allowed[m.style]} disabled={offline} aria-describedby={`merge-${m.style}-description`} onChange={(on) => {
              toggle(m.style, on);
            }}/>
      </SettingRow>
        ))}
        <SettingRow id="merge-default" title="Default merge style" description="Preselected in the merge box.">
          <Select size="small" id="merge-default" aria-labelledby="merge-default-label" value={s.defaultStyle} disabled={offline}
            onChange={(event) => {
              const style = event.target.value as MergeStyle;
              apply({...s, defaultStyle: style}, {default_merge_style: style}, 'The default merge style');
            }}>{defaultStyleChoices(s).map((m) => <Select.Option key={m.style} value={m.style}>{m.label}</Select.Option>)}</Select>
      </SettingRow>
        <SettingRow id="merge-delete" title="Delete the branch after merging" description="Preselected when a pull request is merged.">
          <ToggleSwitch size="small" aria-labelledby="merge-delete-label" checked={s.deleteBranch} disabled={offline} aria-describedby="merge-delete-description" onChange={(on) => {
            flag('deleteBranch', 'default_delete_branch_after_merge', on, 'Deleting branches after merging');
          }}/>
      </SettingRow>
        <SettingRow id="merge-rebase-update" title="Update branches by rebasing" description="Offer to bring a pull request up to date by rebasing it, besides merging.">
          <ToggleSwitch size="small" aria-labelledby="merge-rebase-update-label" checked={s.rebaseUpdate} disabled={offline} aria-describedby="merge-rebase-update-description" onChange={(on) => {
            flag('rebaseUpdate', 'allow_rebase_update', on, 'Updating by rebase');
          }}/>
      </SettingRow>
        <SettingRow id="merge-maintainer" title="Allow edits from maintainers" description="Preselected for new pull requests from forks.">
          <ToggleSwitch size="small" aria-labelledby="merge-maintainer-label" checked={s.maintainerEdit} disabled={offline} aria-describedby="merge-maintainer-description" onChange={(on) => {
            flag('maintainerEdit', 'default_allow_maintainer_edit', on, 'Edits from maintainers');
          }}/>
      </SettingRow>
      </div>
    </FormSection>
  );
});

type Danger = 'visibility' | 'archive' | 'transfer' | 'delete';

const DangerZone = observer(function DangerZone({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const navigate = useNavigate();
  const offline = useReach() !== 'online';
  const priv = useOptimistic(r.private);
  const archived = useOptimistic(r.archived);
  const [open, setOpen] = useState<Danger | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [newOwner, setNewOwner] = useState('');
  const full = `${owner}/${repo}`;
  const close = () => {
    setOpen(undefined);
    setError(undefined);
    setNewOwner('');
  };
  const run = async (fn: () => Promise<void>) => {
    if (offline || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      close();
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  const target = newOwnerOf(newOwner, owner);
  const change = (kind: Danger) => (o: boolean) => {
    if (o) setOpen(kind);
    else if (!busy) close();
  };
  const button = (kind: Danger, label: string) => (
    <Button size="small" variant="danger" type="button" disabled={offline} onClick={() => {
      setOpen(kind);
    }}>{label}</Button>
  );
  return (
    <FormSection id="settings-danger" title="Danger zone">
      <div className="rounded-md border border-danger-emphasis">
      <SettingRow bordered id="danger-visibility" title="Change repository visibility" description={`This repository is currently ${priv.shown ? 'private' : 'public'}.`}
        >{button('visibility', 'Change visibility')}</SettingRow>
      <SettingRow bordered id="danger-transfer" title="Transfer ownership" description="Give it to another user or an organization you can create repositories in."
        >{button('transfer', 'Transfer')}</SettingRow>
      <SettingRow bordered id="danger-archive" title={archived.shown ? 'Unarchive this repository' : 'Archive this repository'}
        description={archived.shown ? 'Make it writable again.' : 'Make it read-only: no pushes, issues or pull requests; it can be unarchived.'}
        >{button('archive', archived.shown ? 'Unarchive this repository' : 'Archive this repository')}</SettingRow>
      <SettingRow bordered id="danger-delete" title="Delete this repository" description="Its code, issues, pull requests, wiki and releases are deleted. This cannot be undone."
        >{button('delete', 'Delete this repository')}</SettingRow>
      </div>

      <RepositoryConfirmation open={open === 'visibility'} onOpenChange={change('visibility')} busy={busy} error={error} tone={priv.shown ? 'danger' : 'primary'} title={priv.shown ? `Make ${full} public?` : `Make ${full} private?`}
        description={priv.shown ? 'Everyone will see its code, issues and pull requests.' : 'Only its owner, collaborators and teams with access will see it. Stars and watchers without access are removed.'}
        confirmLabel={priv.shown ? 'Make public' : 'Make private'} confirmText={priv.shown ? full : undefined}
        onConfirm={() => void run(async () => {
          const to = !priv.shown;
          priv.set(to);
          try {
            await patchRepo(app, owner, repo, {private: to});
            priv.done();
          } catch (err) {
            priv.undo();
            throw err;
          }
          notify(app, {tone: 'success', title: to ? `${full} is private` : `${full} is public`});
        })}/>
      <RepositoryConfirmation open={open === 'archive'} onOpenChange={change('archive')} busy={busy} error={error} tone={archived.shown ? 'primary' : 'danger'} title={archived.shown ? `Unarchive ${full}?` : `Archive ${full}?`}
        description={archived.shown ? 'Pushes, issues and pull requests are possible again.' : 'It becomes read-only for everyone, you included, until it is unarchived.'}
        confirmLabel={archived.shown ? 'Unarchive' : 'Archive'}
        onConfirm={() => void run(async () => {
          const to = !archived.shown;
          archived.set(to);
          try {
            await patchRepo(app, owner, repo, {archived: to});
            archived.done();
          } catch (err) {
            archived.undo();
            throw err;
          }
          notify(app, {tone: 'success', title: to ? `${full} is archived` : `${full} is no longer archived`});
        })}/>
      <RepositoryConfirmation open={open === 'transfer'} onOpenChange={change('transfer')} busy={busy} error={error} title={`Transfer ${full}`} confirmLabel="Transfer" confirmText={full} ready={'owner' in target}
        description="The new owner gets every issue, pull request and setting. A user has to accept the transfer first."
        onConfirm={() => void run(async () => {
          if (!('owner' in target)) return;
          const res = await transferRepo(app, owner, repo, target.owner);
          const moved = res?.owner?.login && res.owner.login.toLowerCase() !== owner.toLowerCase();
          if (moved) {
            notify(app, {tone: 'success', title: `Transferred to ${res.owner?.login ?? target.owner}`});
            void navigate({to: '/$owner/$repo', params: {owner: res.owner?.login ?? target.owner, repo: res.name}});
          } else {
            notify(app, {tone: 'success', title: 'Transfer requested', description: `${target.owner} has to accept it; until then it stays here.`});
          }
        })}>
        <FormControl id="transfer-owner"><FormControl.Label>New owner</FormControl.Label>
          <TextInput className="w-full" value={newOwner} autoComplete="off" spellCheck={false} placeholder="A user or organization" onChange={(e) => {
              setNewOwner(e.target.value);
            }}/>
        {(newOwner.trim() && 'error' in target ? target.error : undefined) && <FormControl.Validation variant="error">{newOwner.trim() && 'error' in target ? target.error : undefined}</FormControl.Validation>}</FormControl>
      </RepositoryConfirmation>
      <RepositoryConfirmation open={open === 'delete'} onOpenChange={change('delete')} busy={busy} error={error} title={`Delete ${full}?`} confirmLabel="Delete this repository" confirmText={full}
        description="Its code, issues, pull requests, wiki, releases and packages are deleted for good."
        onConfirm={() => void run(async () => {
          await deleteRepo(app, owner, repo);
          notify(app, {tone: 'success', title: `Deleted ${full}`});
          void navigate({to: '/'});
        })}/>
    </FormSection>
  );
});
