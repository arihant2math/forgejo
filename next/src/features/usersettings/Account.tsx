// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {MailIcon, PlusIcon, TrashIcon} from '@primer/octicons-react';
import {IconButton, Label, Button as PrimerButton, TextInput, useFormControlForwardedProps} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {notify} from '../../app/notices.ts';
import {useOfflineReason} from '../../app/online.ts';
import type {Resource} from '../../app/resource.ts';
import {useApp} from '../../app/store.ts';
import {count} from '../../app/words.ts';
import {Field} from '../../components/Field.tsx';
import {ListSkeleton} from '../../components/ListSkeleton.tsx';
import {LoadState} from '../../components/LoadState.tsx';
import {AccountList, AccountRow} from './AccountList.tsx';
import {
addEmail,
deleteEmail,
makePrimary,
useUserSettings
} from './data.ts';
import {FormSection} from './form.tsx';
import {
type ApiEmail,
looksLikeEmail,
sortEmails
} from './payload.ts';
import {Confirm, failure, TextClassic} from './SettingsParts.tsx';

export const AccountView = observer(function AccountView() {
  return (
    <>
      <EmailsSection/>
      <FormSection title="Password" description="Change your password, or set one for an account that signs in elsewhere.">
        <div><ClassicLink size="small" to="/user/settings/account" variant="default">Change your password</ClassicLink></div>
      </FormSection>
      <FormSection title="Delete account" description="Once you delete your account, there is no going back: your repositories, organizations you alone own and everything you wrote go with it.">
        <div><ClassicLink size="small" to="/user/settings/account" variant="danger">Delete your account</ClassicLink></div>
      </FormSection>
    </>
  );
});

const EmailsSection = observer(function EmailsSection() {
  const app = useApp();
  const res = useUserSettings('emails');
  const offline = useOfflineReason('Changing your email addresses');
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const list = res.value && sortEmails(res.value);
  const primary = (email: string) => {
    makePrimary(app, res, email).then(() => {
      notify(app, {tone: 'success', title: `${email} is your primary address`});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'The primary address did not change', description: failure(err)});
    });
  };
  const remove = (email: string) => {
    deleteEmail(app, res, email).catch((err: unknown) => {
      notify(app, {tone: 'danger', title: `${email} was not removed`, description: failure(err)});
    });
  };
  return (
    <FormSection title="Email addresses" description="Forgejo sends notifications to your primary address. Any verified address links your commits to you.">
      {list ? (
        <AccountList title={count(list.length, 'address', 'addresses')}>
          {list.map((e) => (
            <AccountRow key={e.email} leading={<MailIcon size={16} className="shrink-0"/>} trailing={<>
              {e.primary && <Label variant="accent">Primary</Label>}
              {e.verified ? <Label variant="success">Verified</Label> : <Label variant="attention">Unverified</Label>}
              {!e.primary && e.verified && <PrimerButton variant="invisible" size="small" type="button" inactive={Boolean(offline)} onClick={() => {
                primary(e.email);
              }}>Make primary</PrimerButton>}
              {!e.primary && <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Remove ${e.email}`} type="button" disabled={Boolean(offline)} onClick={() => {
                setRemoving(e.email);
              }}/>}
            </>}>
              <span title={e.email}>{e.email}</span>
            </AccountRow>
          ))}
        </AccountList>
      ) : <LoadState res={res} what="Your email addresses" skeleton={<ListSkeleton rows={2} lines={1} leading="none"/>}/>}
      {list?.some((e) => !e.verified) && (
        <p className="text-sm text-muted">An unverified address waits for the link Forgejo mailed to it. <TextClassic to="/user/settings/account">Send it again in the classic UI</TextClassic>.</p>
      )}
      <AddEmail res={res} offline={offline}/>
      {removing !== undefined && (
        <Confirm title={`Remove ${removing}?`} description="Commits made with this address are no longer linked to you." action="Remove" onConfirm={() => {
          remove(removing);
        }} onClose={() => {
          setRemoving(undefined);
        }}/>
      )}
    </FormSection>
  );
});

/** Shares its row with the Add button, so it takes the field's label and messages itself. */
function EmailInput({value, invalid, onChange}: {value: string; invalid: boolean; onChange: (value: string) => void}) {
  const wiring = useFormControlForwardedProps({});
  return <TextInput id={wiring.id} aria-describedby={wiring['aria-describedby']} type="email" autoComplete="email" placeholder="you@example.com" value={value} className="min-w-0 flex-1"
    onChange={(e) => { onChange(e.target.value); }} {...(invalid ? {validationStatus: 'error' as const} : {})}/>;
}

const AddEmail = observer(function AddEmail({res, offline}: {res: Resource<ApiEmail[]>; offline: string | undefined}) {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const add = () => {
    const e = email.trim();
    if (saving || offline || !e) return;
    if (!looksLikeEmail(e)) {
      setError('This is not an email address.');
      return;
    }
    setSaving(true);
    setError(undefined);
    addEmail(app, res, e).then(() => {
      setEmail('');
      notify(app, {tone: 'success', title: `Added ${e}`, description: 'If Forgejo asks for it, open the link it mailed to the address to verify it.'});
    }, (err: unknown) => {
      setError(failure(err));
    }).finally(() => {
      setSaving(false);
    });
  };
  return (
    <form className="flex flex-col gap-1" onSubmit={(e) => {
      e.preventDefault();
      add();
    }}>
      <Field label="Add an email address" error={error} hint={offline}>
        <div className="flex gap-2">
          <EmailInput value={email} invalid={Boolean(error)} onChange={(value) => {
            setEmail(value);
            setError(undefined);
          }}/>
          <PrimerButton size="small" leadingVisual={PlusIcon} type="submit" disabled={saving || Boolean(offline) || !email.trim()}>{saving ? 'Adding…' : 'Add'}</PrimerButton>
        </div>
      </Field>
    </form>
  );
});
