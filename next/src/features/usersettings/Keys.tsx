// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {KeyIcon, LockIcon, PlusIcon, TrashIcon} from '@primer/octicons-react';
import {IconButton, Label, Button as PrimerButton, Textarea, TextInput} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {notify} from '../../app/notices.ts';
import {useOfflineReason} from '../../app/online.ts';
import type {Resource} from '../../app/resource.ts';
import {useApp} from '../../app/store.ts';
import {count} from '../../app/words.ts';
import {EmptyState} from '../../components/EmptyState.tsx';
import {Field} from '../../components/Field.tsx';
import {ListSkeleton} from '../../components/ListSkeleton.tsx';
import {LoadState} from '../../components/LoadState.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {AccountList, AccountRow} from './AccountList.tsx';
import {
addGpgKey,addKey,
deleteGpgKey,deleteKey,
useUserSettings
} from './data.ts';
import {FormActions, FormSection} from './form.tsx';
import {
type ApiGPGKey,type ApiPublicKey,
expired,gpgKeyProblem,
spacedKeyId,sshKeyProblem,
sshKeyTitle
} from './payload.ts';
import {Confirm, failure, TextClassic} from './SettingsParts.tsx';

export const KeysView = observer(function KeysView() {
  return (
    <>
      <SshKeys/>
      <GpgKeys/>
      <p className="text-sm text-muted">
        Verifying a key, and SSH certificate principals, are in the <TextClassic to="/user/settings/keys">classic UI</TextClassic>.
      </p>
    </>
  );
});

const SshKeys = observer(function SshKeys() {
  const app = useApp();
  const res = useUserSettings('keys');
  const offline = useOfflineReason('Changing your SSH keys');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ApiPublicKey | undefined>(undefined);
  const list = res.value;
  return (
    <FormSection title="SSH keys" description="The keys that may push and pull over SSH as you."
      actions={!adding && <PrimerButton size="small" leadingVisual={PlusIcon} type="button" inactive={Boolean(offline)} onClick={() => {
        setAdding(true);
      }}>New SSH key</PrimerButton>}>
      {adding && <AddSshKey res={res} offline={offline} onDone={() => {
        setAdding(false);
      }}/>}
      {list ? (list.length ? (
        <AccountList title={count(list.length, 'key', 'keys')}>
          {list.map((k) => (
            <AccountRow key={k.id} leading={<KeyIcon size={16} className="shrink-0"/>} trailing={<>
              {k.verified && <Label variant="success">Verified</Label>}
              <TimeAgo at={k.created_at} label="Added"/>
              <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Delete ${k.title ?? 'this key'}`} type="button" disabled={Boolean(offline)} onClick={() => {
                setRemoving(k);
              }}/>
            </>}>
              <span className="font-semibold">{k.title}</span>
              {k.fingerprint && <code className="ml-4 text-sm text-muted" title={k.fingerprint}>{k.fingerprint}</code>}
            </AccountRow>
          ))}
        </AccountList>
      ) : !adding && <EmptyState icon={KeyIcon} title="No SSH keys" description="Add one to push and pull over SSH." spacious={false}/>) :
        <LoadState res={res} what="Your SSH keys" skeleton={<ListSkeleton rows={2} lines={1} leading="none"/>}/>}
      {removing && (
        <Confirm title={`Delete “${removing.title ?? 'SSH key'}”?`} description="It can no longer push or pull as you." action="Delete key" onConfirm={() => {
          deleteKey(app, res, removing.id).catch((err: unknown) => {
            notify(app, {tone: 'danger', title: 'The key was not deleted', description: failure(err)});
          });
        }} onClose={() => {
          setRemoving(undefined);
        }}/>
      )}
    </FormSection>
  );
});

const AddSshKey = observer(function AddSshKey({res, offline, onDone}: {res: Resource<ApiPublicKey[]>; offline: string | undefined; onDone: () => void}) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const add = () => {
    if (saving || offline) return;
    const problem = sshKeyProblem(key);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    const name = sshKeyTitle(title, key);
    addKey(app, res, name, key.trim()).then(() => {
      notify(app, {tone: 'success', title: `Added the SSH key “${name}”`});
      onDone();
    }, (err: unknown) => {
      setError(failure(err));
      setSaving(false);
    });
  };
  return (
    <form className="flex flex-col gap-4 rounded-md border border-default p-4" onSubmit={(e) => {
      e.preventDefault();
      add();
    }}>
      <Field label="Title" hint="Optional: the key's comment, else its type.">
        <TextInput value={title} className="w-full" maxLength={255} placeholder="Laptop" onChange={(e) => {
          setTitle(e.target.value);
        }}/>
      </Field>
      <Field label="Key" hint="Your public key: the contents of ~/.ssh/id_ed25519.pub, for example." error={error}>
        <Textarea value={key} rows={4} autoFocus spellCheck={false} placeholder="ssh-ed25519 AAAA… you@example.com" onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }} block/>
      </Field>
      <FormActions note={offline}>
        <PrimerButton size="small" variant="invisible" type="button" onClick={onDone}>Cancel</PrimerButton>
        <PrimerButton size="small" variant="primary" type="submit" disabled={saving || Boolean(offline) || !key.trim()}>{saving ? 'Adding…' : 'Add SSH key'}</PrimerButton>
      </FormActions>
    </form>
  );
});

const GpgKeys = observer(function GpgKeys() {
  const app = useApp();
  const res = useUserSettings('gpg');
  const offline = useOfflineReason('Changing your GPG keys');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ApiGPGKey | undefined>(undefined);
  const list = res.value;
  return (
    <FormSection title="GPG keys" description="The keys whose signatures mark your commits as verified."
      actions={!adding && <PrimerButton size="small" leadingVisual={PlusIcon} type="button" inactive={Boolean(offline)} onClick={() => {
        setAdding(true);
      }}>New GPG key</PrimerButton>}>
      {adding && <AddGpgKey res={res} offline={offline} onDone={() => {
        setAdding(false);
      }}/>}
      {list ? (list.length ? (
        <AccountList title={count(list.length, 'key', 'keys')}>
          {list.map((k) => {
            const emails = (k.emails ?? []).map((e) => e.email).join(', ');
            return (
              <AccountRow key={k.id} leading={<LockIcon size={16} className="shrink-0"/>} trailing={<>
                {k.verified ? <Label variant="success">Verified</Label> : <Label>Unverified</Label>}
                {expired(k.expires_at) && <Label variant="attention">Expired</Label>}
                <TimeAgo at={k.created_at} label="Added"/>
                <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Delete the key ${k.key_id}`} type="button" disabled={Boolean(offline)} onClick={() => {
                  setRemoving(k);
                }}/>
              </>}>
                <code className="font-semibold">{spacedKeyId(k.key_id)}</code>
                {emails && <span className="ml-4 text-muted" title={emails}>{emails}</span>}
              </AccountRow>
            );
          })}
        </AccountList>
      ) : !adding && <EmptyState icon={LockIcon} title="No GPG keys" description="Add one to have your signed commits verified." spacious={false}/>) :
        <LoadState res={res} what="Your GPG keys" skeleton={<ListSkeleton rows={2} lines={1} leading="none"/>}/>}
      {removing && (
        <Confirm title={`Delete the key ${spacedKeyId(removing.key_id)}?`} description="Commits it signed no longer show as verified." action="Delete key" onConfirm={() => {
          deleteGpgKey(app, res, removing.id).catch((err: unknown) => {
            notify(app, {tone: 'danger', title: 'The key was not deleted', description: failure(err)});
          });
        }} onClose={() => {
          setRemoving(undefined);
        }}/>
      )}
    </FormSection>
  );
});

const AddGpgKey = observer(function AddGpgKey({res, offline, onDone}: {res: Resource<ApiGPGKey[]>; offline: string | undefined; onDone: () => void}) {
  const app = useApp();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const add = () => {
    if (saving || offline) return;
    const problem = gpgKeyProblem(key);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    addGpgKey(app, res, key.trim()).then((k) => {
      notify(app, {tone: 'success', title: `Added the GPG key ${spacedKeyId(k.key_id)}`});
      onDone();
    }, (err: unknown) => {
      setError(failure(err));
      setSaving(false);
    });
  };
  return (
    <form className="flex flex-col gap-4 rounded-md border border-default p-4" onSubmit={(e) => {
      e.preventDefault();
      add();
    }}>
      <Field label="Key" hint="The output of gpg --armor --export <key id>." error={error}>
        <Textarea value={key} rows={6} autoFocus spellCheck={false} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }} block/>
      </Field>
      <FormActions note={offline}>
        <PrimerButton size="small" variant="invisible" type="button" onClick={onDone}>Cancel</PrimerButton>
        <PrimerButton size="small" variant="primary" type="submit" disabled={saving || Boolean(offline) || !key.trim()}>{saving ? 'Adding…' : 'Add GPG key'}</PrimerButton>
      </FormActions>
    </form>
  );
});
