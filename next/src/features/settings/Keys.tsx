// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's deploy keys (/{owner}/{repo}/settings/keys): SSH keys that
// give a machine access to this one repository. Listed from API v1 (kept
// for the next visit), added in a dialog, deleted after a confirmation.

import {KeyRound, Plus, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {Badge, Button, Callout, Checkbox, Code, ConfirmDialog, Dialog, Entry, Field, FormSection, hintId, Icon, IconButton, Input, TextArea} from '../../ui/index.ts';
import {fullDate, shortDate} from '../issues/format.ts';
import {ResourceList, useOffline} from './bits.tsx';
import type {FieldErrors} from './forms.ts';
import {problemOf} from './problems.ts';
import {fetchKeys, repoApi} from './requests.ts';
import {settingsKey, useResource} from './resource.ts';
import {type DeployKey, keyCreate, type KeyForm, validateKey} from './rules.ts';

export const KeySettings = observer(function KeySettings({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const offline = useOffline();
  const res = useResource(settingsKey(repoId, 'keys'), (signal) => fetchKeys(app, owner, repo, signal));
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DeployKey | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async (k: DeployKey) => {
    setBusy(true);
    setError(undefined);
    try {
      await online(app, {method: 'DELETE', api: 'v1', path: `${repoApi(owner, repo)}/keys/${String(k.id)}`});
      res.update((list) => (list ?? []).filter((x) => x.id !== k.id));
      setDeleting(undefined);
      notify(app, {tone: 'success', title: `Deleted the key “${k.title}”`});
    } catch (err) {
      setError(problemOf(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSection id="settings-keys" title="Deploy keys" description="SSH keys that can clone (and, with write access, push to) this repository only."
      actions={<Button size="sm" variant="primary" icon={Plus} disabled={offline} onClick={() => {
        setAdding(true);
      }}>Add key</Button>}>
      <ResourceList res={res} what="The deploy keys" empty={{icon: KeyRound, title: 'No deploy keys', description: 'Add one to let a server or a CI job clone this repository.'}}>
        {(keys) => keys.map((k) => (
          <Entry key={k.id} leading={<Icon icon={KeyRound} size="sm"/>} title={k.title}
            meta={<time dateTime={k.created_at} title={fullDate(k.created_at)}>{shortDate(k.created_at)}</time>}
            description={<span className="flex flex-wrap items-center gap-1"><Badge tone={k.read_only ? 'neutral' : 'warning'}>{k.read_only ? 'Read' : 'Read and write'}</Badge><Code>{k.fingerprint}</Code></span>}
            actions={<IconButton size="sm" icon={Trash2} label={`Delete the key “${k.title}”`} disabled={offline} onClick={() => {
              setError(undefined);
              setDeleting(k);
            }}/>}/>
        ))}
      </ResourceList>
      {adding && <KeyDialog owner={owner} repo={repo} onClose={() => {
        setAdding(false);
      }} onSaved={(k) => {
        res.update((list) => [...(list ?? []).filter((x) => x.id !== k.id), k]);
        setAdding(false);
      }}/>}
      <ConfirmDialog open={deleting !== undefined} onOpenChange={(o) => {
        if (!o && !busy) setDeleting(undefined);
      }} title={`Delete the key “${deleting?.title ?? ''}”?`} description="Whatever uses it can no longer reach this repository."
      confirmLabel="Delete key" busy={busy} error={error} onConfirm={() => {
        if (deleting) void remove(deleting);
      }}/>
    </FormSection>
  );
});

const KEY_FIELDS: Record<string, keyof KeyForm> = {title: 'title', key: 'key'};

function KeyDialog({owner, repo, onClose, onSaved}: {owner: string; repo: string; onClose: () => void; onSaved: (k: DeployKey) => void}) {
  const app = useApp();
  const [form, setForm] = useState<KeyForm>({title: '', key: '', write: false});
  const [errors, setErrors] = useState<FieldErrors<keyof KeyForm>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof KeyForm>(k: K, v: KeyForm[K]) => {
    setForm({...form, [k]: v});
    if (errors[k]) setErrors({...errors, [k]: undefined});
  };
  const save = async () => {
    const errs = validateKey(form);
    setErrors(errs);
    setFailure(undefined);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const k = await online<DeployKey>(app, {method: 'POST', api: 'v1', path: `${repoApi(owner, repo)}/keys`, body: keyCreate(form)});
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
    <Dialog open title="Add a deploy key" onOpenChange={(o) => {
      if (!o && !busy) onClose();
    }} footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Adding…' : 'Add key'}</Button>
    </>}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}>
        <Field htmlFor="key-title" errorId={hintId('key-title')} label="Title" error={errors.title} hint="What uses it (“CI runner”, “docs server”).">
          <Input id="key-title" className="w-full" value={form.title} autoFocus maxLength={50} invalid={Boolean(errors.title)} aria-describedby={hintId('key-title')}
            onChange={(e) => {
              set('title', e.target.value);
            }}/>
        </Field>
        <Field htmlFor="key-key" errorId={hintId('key-key')} label="Key" error={errors.key} hint="The public key: the contents of a .pub file, starting with ssh-ed25519, ssh-rsa, ecdsa-… or sk-….">
          <TextArea id="key-key" rows={4} value={form.key} spellCheck={false} invalid={Boolean(errors.key)} aria-describedby={hintId('key-key')} onChange={(e) => {
            set('key', e.target.value);
          }}/>
        </Field>
        <Checkbox label="Allow write access (pushing)" checked={form.write} onChange={(v) => {
          set('write', v);
        }}/>
        {failure && <Callout tone="danger" title="Not added">{failure}</Callout>}
      </form>
    </Dialog>
  );
}
