// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {apiRepoPath} from '../../app/paths.ts';
import {SettingsEntry} from './SettingsEntry.tsx';
import {RepositoryConfirmation, useRemoval} from './RepositoryConfirmation.tsx';
import {FormSection} from '../usersettings/form.tsx';
import {Banner, Label, Button, IconButton, Checkbox, FormControl, Dialog, TextInput, Textarea} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {OfflineNote, ResourceList, useOffline} from './bits.tsx';
import type {FieldErrors} from './forms.ts';
import {problemOf} from './problems.ts';
import {fetchKeys} from './requests.ts';
import {settingsKey, useResource} from './resource.ts';
import {type DeployKey, keyCreate, type KeyForm, validateKey} from './rules.ts';
import {KeyIcon, PlusIcon, TrashIcon} from '@primer/octicons-react';

export const KeySettings = observer(function KeySettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useOffline();
  const res = useResource(settingsKey(repoId, 'keys'), (signal) => fetchKeys(app, owner, repo, signal));
  const [adding, setAdding] = useState(false);
  const removal = useRemoval(res, {path: (k) => `${apiRepoPath(owner, repo)}/keys/${String(k.id)}`, same: (a, b) => a.id === b.id, done: (k) => `Deleted the key “${k.title}”`});
  return (
    <FormSection id="settings-keys" title="Deploy keys" description="SSH keys that can clone (and, with write access, push to) this repository only."
      actions={<Button variant="primary" size="small" leadingVisual={PlusIcon} type="button" disabled={offline} onClick={() => {
        setAdding(true);
      }}>Add key</Button>}>
      <ResourceList res={res} what="The deploy keys" empty={{icon: KeyIcon, title: 'No deploy keys', description: 'Add one to let a server or a CI job clone this repository.'}}>
        {(keys) => keys.map((k) => (
          <SettingsEntry key={k.id} leading={<KeyIcon size={16} className="shrink-0"/>} title={k.title}
            meta={<time dateTime={k.created_at} title={fullDate(k.created_at)}>{shortDate(k.created_at)}</time>}
            description={<span className="flex flex-wrap items-center gap-1"><Label variant={k.read_only ? 'default' : 'attention'}>{k.read_only ? 'Read' : 'Read and write'}</Label><code>{k.fingerprint}</code></span>}
            actions={<IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Delete the key “${k.title}”`} type="button" disabled={offline} onClick={() => {
              removal.ask(k);
            }}/>}/>
        ))}
      </ResourceList>
      {adding && <KeyDialog owner={owner} repo={repo} onClose={() => {
        setAdding(false);
      }} onSaved={(k) => {
        res.update((list) => [...(list ?? []).filter((x) => x.id !== k.id), k]);
        setAdding(false);
      }}/>}
      <RepositoryConfirmation {...removal.dialog} title={`Delete the key “${removal.target?.title ?? ''}”?`} description="Whatever uses it can no longer reach this repository."
        confirmLabel="Delete key"/>
    </FormSection>
  );
});

const KEY_FIELDS: Record<string, keyof KeyForm> = {title: 'title', key: 'key'};

const KeyDialog = observer(function KeyDialog({owner, repo, onClose, onSaved}: {owner: string; repo: string; onClose: () => void; onSaved: (k: DeployKey) => void}) {
  const app = useApp();
  const offline = useOffline();
  const [form, setForm] = useState<KeyForm>({title: '', key: '', write: false});
  const [errors, setErrors] = useState<FieldErrors<keyof KeyForm>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof KeyForm>(k: K, v: KeyForm[K]) => {
    setForm({...form, [k]: v});
    if (errors[k]) setErrors({...errors, [k]: undefined});
  };
  const save = async () => {
    if (busy || offline) return;
    const errs = validateKey(form);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const k = await online<DeployKey>(app, {method: 'POST', api: 'v1', path: `${apiRepoPath(owner, repo)}/keys`, body: keyCreate(form)});
      if (k) onSaved(k);
      else onClose();
      notify(app, {tone: 'success', title: `Added the key “${form.title.trim()}”`});
    } catch (err) {
      const p = problemOf(err, KEY_FIELDS);
      if (p.field) setErrors({[p.field]: p.message});
      else setFailure(p.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add a deploy key" width="large" onClose={() => { if (!busy) onClose(); }} footerButtons={[
      {content: 'Cancel', disabled: busy, onClick: onClose},
      {content: busy ? 'Adding…' : 'Add key', buttonType: 'primary', disabled: busy || offline, onClick: () => void save()},
    ]}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <OfflineNote/>
        <FormControl id="key-title"><FormControl.Label>Title</FormControl.Label>
          <TextInput className="w-full" value={form.title} autoFocus maxLength={50} onChange={(e) => {
              set('title', e.target.value);
            }} {...(errors.title ? {validationStatus: 'error' as const} : {})}/>
        <FormControl.Caption>What uses it (“CI runner”, “docs server”).</FormControl.Caption>{errors.title && <FormControl.Validation variant="error">{errors.title}</FormControl.Validation>}</FormControl>
        <FormControl id="key-key"><FormControl.Label>Key</FormControl.Label>
          <Textarea rows={4} value={form.key} spellCheck={false} onChange={(e) => {
            set('key', e.target.value);
          }} block {...(errors.key ? {validationStatus: 'error' as const} : {})}/>
        <FormControl.Caption>The public key: the contents of a .pub file, starting with ssh-ed25519, ssh-rsa, ecdsa-… or sk-….</FormControl.Caption>{errors.key && <FormControl.Validation variant="error">{errors.key}</FormControl.Validation>}</FormControl>
        <FormControl><Checkbox checked={form.write} onChange={(event) => { const v = event.target.checked; set('write', v); }}/><FormControl.Label>Allow write access (pushing)</FormControl.Label></FormControl>
        {failure && <Banner variant="critical" title="Not added" description={<>{failure}</>}/>}
      </form>
    </Dialog>
  );
});
