// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's general settings (/{owner}/{repo}/settings), all from the
// pool (instant, offline too): name, description and website (one form,
// saved together); the default branch, the features, the template flag and
// the pull request merge styles (each applies on change, shown at once);
// and the danger zone — visibility, archiving, transfer, deletion — each
// behind a confirmation. Writes are API v1 `PATCH /repos/{owner}/{repo}`
// with only the changed fields, online only.

import {useNavigate} from '@tanstack/react-router';
import {GitBranch} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import type {Repository} from '../../protocol/types.gen.ts';
import {
  Button, Callout, CommandPopover, ConfirmDialog, Field, FormSection, hintId, Input, Select, SettingRow, Switch, TextArea,
} from '../../ui/index.ts';
import {refTable} from '../code/hooks.ts';
import {usePool} from '../issues/cells.tsx';
import {sendChange, useOffline, useOptimistic} from './bits.tsx';
import {
  defaultStyleChoices, type Details, detailsOf, detailsPatch, FEATURES, type Feature, featureState, type FieldErrors, type MergeStyle,
  mergeStyleToggle, MERGE_STYLES, newOwnerOf, type PullSettings, pullSettingsOf, type RepoPatch, sameDetails, validateDetails,
} from './forms.ts';
import {problemOf} from './problems.ts';
import {deleteRepo, patchRepo, transferRepo} from './requests.ts';

export const GeneralSettings = observer(function GeneralSettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const pool = usePool();
  const r = pool.model('Repository').get(repoId)?.data;
  if (!r) return null;
  const units = new Set([...pool.model('RepoUnit').by('repo_id', repoId)].map((u) => u.get('type')));
  const pulls = [...pool.model('RepoUnit').by('repo_id', repoId)].find((u) => u.get('type') === 'pulls')?.data.config;
  return (
    <>
      {r.archived && <Callout tone="warning" title="This repository is archived">It is read-only. Unarchive it in the danger zone below to change it again.</Callout>}
      <DetailsForm owner={owner} repo={repo} r={r}/>
      <DefaultBranch owner={owner} repo={repo} r={r}/>
      <Features owner={owner} repo={repo} r={r} units={units}/>
      {pulls && <PullRequests owner={owner} repo={repo} config={pulls}/>}
      <DangerZone owner={owner} repo={repo} r={r}/>
    </>
  );
});

const DETAIL_FIELDS: Record<string, keyof Details> = {name: 'name', 'repo name': 'name', description: 'description', website: 'website'};

/** Name, description, website: one form, saved together (only what changed is sent). */
function DetailsForm({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const navigate = useNavigate();
  const offline = useOffline();
  const fresh = detailsOf(r);
  const [base, setBase] = useState(fresh);
  const [form, setForm] = useState(fresh);
  // Saved, and not synced back yet: the form keeps what was saved meanwhile.
  const [expect, setExpect] = useState<Details | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors<keyof Details>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (expect && sameDetails(fresh, expect)) setExpect(undefined);
  // The pool moved (someone else's change, or ours synced back): an untouched form follows it.
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
      // Renamed: the page's address follows (the old one redirects in Forgejo).
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
        <Field htmlFor="repo-name" errorId={hintId('repo-name')} label="Repository name" error={errors.name}
          hint={form.name.trim() !== base.name ? 'Renaming changes its address; Forgejo redirects the old one.' : undefined}>
          <Input id="repo-name" className="w-full" value={form.name} maxLength={100} autoComplete="off" spellCheck={false} invalid={Boolean(errors.name)}
            aria-describedby={hintId('repo-name')} onChange={(e) => {
              edit('name', e.target.value);
            }}/>
        </Field>
        <Field htmlFor="repo-description" errorId={hintId('repo-description')} label="Description" optional error={errors.description}>
          <TextArea id="repo-description" rows={3} value={form.description} invalid={Boolean(errors.description)} aria-describedby={hintId('repo-description')}
            onChange={(e) => {
              edit('description', e.target.value);
            }}/>
        </Field>
        <Field htmlFor="repo-website" errorId={hintId('repo-website')} label="Website" optional error={errors.website}>
          <Input id="repo-website" type="url" className="w-full" placeholder="https://" value={form.website} invalid={Boolean(errors.website)}
            aria-describedby={hintId('repo-website')} onChange={(e) => {
              edit('website', e.target.value);
            }}/>
        </Field>
        {failure && <Callout tone="danger" title="Not saved">{failure}</Callout>}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || busy || offline}>{busy ? 'Saving…' : 'Save changes'}</Button>
          {dirty && <Button variant="ghost" disabled={busy} onClick={() => {
            setForm(base);
            setErrors({});
            setFailure(undefined);
          }}>Discard</Button>}
        </div>
      </form>
    </FormSection>
  );
}

/** The default branch: a picker over the repository's branches (pool), applied on choice. */
const DefaultBranch = observer(function DefaultBranch({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const pool = usePool();
  const offline = useOffline();
  const opt = useOptimistic(r.default_branch);
  const branches = [...refTable(pool, r.id).branches.keys()].sort((a, b) => (a === r.default_branch ? -1 : b === r.default_branch ? 1 : a.localeCompare(b)));
  return (
    <FormSection id="settings-branch" title="Default branch" description="The branch the repository opens on, and the base of new pull requests.">
      <div className="flex items-center gap-2">
        <CommandPopover label="Default branch" placeholder="Find a branch…" empty={r.empty ? 'This repository has no branches yet.' : 'No branches on this device yet.'}
          trigger={<Button icon={GitBranch} disabled={offline || r.archived} aria-label={`Default branch: ${opt.shown || 'none'}`}>{opt.shown || 'None'}</Button>}
          options={branches.map((b) => ({value: b, label: b, checked: b === opt.shown, onSelect: () => {
            if (b === opt.shown) return;
            sendChange(app, opt, b, 'The default branch', () => patchRepo(app, owner, repo, {default_branch: b}), `The default branch is ${b}`);
          }}))}/>
      </div>
    </FormSection>
  );
});

/** The features (units) and the template flag: switches that apply at once. */
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

function FeatureRow({owner, repo, feature: f, state, archived}: {owner: string; repo: string; feature: Feature; state: {on: boolean; external: boolean}; archived: boolean}) {
  const app = useApp();
  const offline = useOffline();
  const opt = useOptimistic(state.on);
  const id = `feature-${f.unit}`;
  const description = state.external ? `${f.description} It uses an external ${f.unit === 'wiki' ? 'wiki' : 'tracker'}: change that in the classic UI (Units).` : f.description;
  return (
    <SettingRow id={id} title={f.label} description={description} control={
      <Switch id={id} checked={opt.shown} disabled={offline || state.external || archived} describedBy={hintId(id)} onCheckedChange={(on) => {
        sendChange(app, opt, on, f.label, () => patchRepo(app, owner, repo, {[f.key]: on}));
      }}/>
    }/>
  );
}

/** A flag of the repository applied at once (template). */
function FlagRow({owner, repo, id, title, description, field, value, archived}: {
  owner: string; repo: string; id: string; title: string; description: string; field: 'template'; value: boolean; archived: boolean;
}) {
  const app = useApp();
  const offline = useOffline();
  const opt = useOptimistic(value);
  return (
    <SettingRow id={id} title={title} description={description} control={
      <Switch id={id} checked={opt.shown} disabled={offline || archived} describedBy={hintId(id)} onCheckedChange={(on) => {
        sendChange(app, opt, on, title, () => patchRepo(app, owner, repo, {[field]: on}));
      }}/>
    }/>
  );
}

/** Pull requests: the merge styles offered, the default one, and the defaults of a new pull request. */
function PullRequests({owner, repo, config}: {owner: string; repo: string; config: Record<string, unknown>}) {
  const app = useApp();
  const offline = useOffline();
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
          <SettingRow key={m.style} id={`merge-${m.style}`} title={m.label} description={m.description} control={
            <Switch id={`merge-${m.style}`} checked={s.allowed[m.style]} disabled={offline} describedBy={hintId(`merge-${m.style}`)} onCheckedChange={(on) => {
              toggle(m.style, on);
            }}/>
          }/>
        ))}
        <SettingRow id="merge-default" title="Default merge style" description="Preselected in the merge box." control={
          <Select id="merge-default" value={s.defaultStyle} disabled={offline} options={defaultStyleChoices(s).map((m) => ({value: m.style, label: m.label}))}
            onValueChange={(v) => {
              apply({...s, defaultStyle: v}, {default_merge_style: v}, 'The default merge style');
            }}/>
        }/>
        <SettingRow id="merge-delete" title="Delete the branch after merging" description="Preselected when a pull request is merged." control={
          <Switch id="merge-delete" checked={s.deleteBranch} disabled={offline} describedBy={hintId('merge-delete')} onCheckedChange={(on) => {
            flag('deleteBranch', 'default_delete_branch_after_merge', on, 'Deleting branches after merging');
          }}/>
        }/>
        <SettingRow id="merge-rebase-update" title="Update branches by rebasing" description="Offer to bring a pull request up to date by rebasing it, besides merging." control={
          <Switch id="merge-rebase-update" checked={s.rebaseUpdate} disabled={offline} describedBy={hintId('merge-rebase-update')} onCheckedChange={(on) => {
            flag('rebaseUpdate', 'allow_rebase_update', on, 'Updating by rebase');
          }}/>
        }/>
        <SettingRow id="merge-maintainer" title="Allow edits from maintainers" description="Preselected for new pull requests from forks." control={
          <Switch id="merge-maintainer" checked={s.maintainerEdit} disabled={offline} describedBy={hintId('merge-maintainer')} onCheckedChange={(on) => {
            flag('maintainerEdit', 'default_allow_maintainer_edit', on, 'Edits from maintainers');
          }}/>
        }/>
      </div>
    </FormSection>
  );
}

type Danger = 'visibility' | 'archive' | 'transfer' | 'delete';

/** Visibility, archiving, transfer and deletion: each asks first; deleting and transferring ask for the name. */
function DangerZone({owner, repo, r}: {owner: string; repo: string; r: Repository}) {
  const app = useApp();
  const navigate = useNavigate();
  const offline = useOffline();
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
    <Button variant="secondary" disabled={offline} onClick={() => {
      setOpen(kind);
    }}>{label}</Button>
  );
  return (
    <FormSection id="settings-danger" title="Danger zone" tone="danger">
      <SettingRow id="danger-visibility" title="Visibility" description={priv.shown ? 'Private: only people with access see it.' : 'Public: everyone can see it.'}
        control={button('visibility', priv.shown ? 'Make public' : 'Make private')}/>
      <SettingRow id="danger-archive" title={archived.shown ? 'Unarchive this repository' : 'Archive this repository'}
        description={archived.shown ? 'Make it writable again.' : 'Make it read-only: no pushes, issues or pull requests; it can be unarchived.'}
        control={button('archive', archived.shown ? 'Unarchive' : 'Archive')}/>
      <SettingRow id="danger-transfer" title="Transfer ownership" description="Give it to another user or an organization you can create repositories in."
        control={button('transfer', 'Transfer')}/>
      <SettingRow id="danger-delete" title="Delete this repository" description="Its code, issues, pull requests, wiki and releases are deleted. This cannot be undone."
        control={<Button variant="danger" disabled={offline} onClick={() => {
          setOpen('delete');
        }}>Delete</Button>}/>

      <ConfirmDialog open={open === 'visibility'} onOpenChange={change('visibility')} busy={busy} error={error} tone={priv.shown ? 'danger' : 'primary'} title={priv.shown ? `Make ${full} public?` : `Make ${full} private?`}
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
      <ConfirmDialog open={open === 'archive'} onOpenChange={change('archive')} busy={busy} error={error} tone={archived.shown ? 'primary' : 'danger'} title={archived.shown ? `Unarchive ${full}?` : `Archive ${full}?`}
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
      <ConfirmDialog open={open === 'transfer'} onOpenChange={change('transfer')} busy={busy} error={error} title={`Transfer ${full}`} confirmLabel="Transfer" confirmText={full} ready={'owner' in target}
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
        <Field htmlFor="transfer-owner" errorId={hintId('transfer-owner')} label="New owner" error={newOwner.trim() && 'error' in target ? target.error : undefined}>
          <Input id="transfer-owner" className="w-full" value={newOwner} autoComplete="off" spellCheck={false} placeholder="A user or organization"
            aria-describedby={hintId('transfer-owner')} onChange={(e) => {
              setNewOwner(e.target.value);
            }}/>
        </Field>
      </ConfirmDialog>
      <ConfirmDialog open={open === 'delete'} onOpenChange={change('delete')} busy={busy} error={error} title={`Delete ${full}?`} confirmLabel="Delete this repository" confirmText={full}
        description="Its code, issues, pull requests, wiki, releases and packages are deleted for good."
        onConfirm={() => void run(async () => {
          await deleteRepo(app, owner, repo);
          notify(app, {tone: 'success', title: `Deleted ${full}`});
          void navigate({to: '/'});
        })}/>
    </FormSection>
  );
}
