// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner, Button as PrimerButton, Textarea, TextInput} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useId, useState} from 'react';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {notify} from '../../app/notices.ts';
import {useOfflineReason} from '../../app/online.ts';
import type {Resource} from '../../app/resource.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Field} from '../../components/Field.tsx';
import {ListSkeleton} from '../../components/ListSkeleton.tsx';
import {LoadState} from '../../components/LoadState.tsx';
import {problemOf} from '../settings/problems.ts';
import {AvatarEditor} from './Avatar.tsx';
import {
patchSettings,
useUserSettings
} from './data.ts';
import {FormActions, FormSection, SettingRow} from './form.tsx';
import {
keepUnsaved,
type Profile,PROFILE_API_FIELDS,PROFILE_FIELDS,PROFILE_LIMITS,
type ProfileField,
profileOf,profilePayload,profileProblems,
shownProfile,
type UserSettings
} from './payload.ts';
import {failure, Toggle} from './SettingsParts.tsx';

const LABELS: Record<ProfileField, string> = {full_name: 'Name', pronouns: 'Pronouns', website: 'Website', location: 'Location', description: 'Bio'};

const HINTS: Partial<Record<ProfileField, string>> = {
  full_name: 'Shown next to your username.',
  website: 'An http:// or https:// address.',
  description: 'A few words about yourself (markdown).',
};

export const ProfileView = observer(function ProfileView() {
  const res = useUserSettings('settings');
  const {data, userId} = useSession();
  const user = data.pool.model('User').get(userId);
  const settings = res.value;
  // Settings include private pronouns; the public pool profile is only a fallback.
  const current: Profile = settings ? profileOf(settings) : profileOf({
    full_name: user?.get('full_name') ?? '', pronouns: user?.get('pronouns') ?? '', website: user?.get('website') ?? '',
    location: user?.get('location') ?? '', description: user?.get('description') ?? '',
  });
  return (
    <>
      <AvatarEditor/>
      <ProfileForm res={res} current={current}/>
      <PrivacySection res={res} visibility={user?.get('visibility') ?? ''}/>
    </>
  );
});

const ProfileForm = observer(function ProfileForm({res, current}: {res: Resource<UserSettings>; current: Profile}) {
  const app = useApp();
  const base = useId();
  const [draft, setDraft] = useState<Partial<Profile>>({});
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const offline = useOfflineReason('Saving your profile');
  const shown = shownProfile(draft, current);
  const payload = profilePayload(draft, current);
  const save = () => {
    if (saving || offline) return;
    const problems = profileProblems(shown);
    if (Object.keys(problems).length) {
      setErrors(problems);
      document.getElementById(`${base}-${PROFILE_FIELDS.find((f) => problems[f]) ?? 'full_name'}`)?.focus();
      return;
    }
    if (!payload) return;
    setSaving(true);
    setErrors({});
    setFormError(undefined);
    patchSettings(app, res, payload, false).then(() => {
      // Clear only saved draft values, preserving edits typed during the request.
      setDraft((d) => keepUnsaved(d, payload));
      notify(app, {tone: 'success', title: 'Profile saved'});
    }, (err: unknown) => {
      const problem = problemOf(err, PROFILE_API_FIELDS);
      const field = PROFILE_FIELDS.find((f) => f === problem.field);
      if (field) {
        setErrors({[field]: problem.message});
        document.getElementById(`${base}-${field}`)?.focus();
      } else {
        setFormError(failure(err));
      }
    }).finally(() => {
      setSaving(false);
    });
  };
  const edit = (f: ProfileField, v: string) => {
    setDraft((d) => ({...d, [f]: v}));
    if (errors[f]) setErrors((e) => ({...e, [f]: undefined}));
  };
  return (
    <FormSection title="Public profile" description="What everyone sees on your profile and next to your name.">
      <form className="flex flex-col gap-4" onSubmit={(e) => {
        e.preventDefault();
        save();
      }}>
        {formError !== undefined && <Banner variant="critical" title="Not saved" description={<>{formError}</>}/>}
        {PROFILE_FIELDS.map((f) => {
          const max = PROFILE_LIMITS[f] * 2;
          return (
            <Field key={f} id={`${base}-${f}`} label={LABELS[f]} hint={HINTS[f]} error={errors[f]}>
              {f === 'description' ?
                <Textarea value={shown[f]} maxLength={max} rows={4} onChange={(e) => {
                  edit(f, e.target.value);
                }} onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    save();
                  }
                }} block/> :
                <TextInput value={shown[f]} maxLength={max} className="w-full" type={f === 'website' ? 'url' : 'text'} inputMode={f === 'website' ? 'url' : undefined} onChange={(e) => {
                  edit(f, e.target.value);
                }}/>}
            </Field>
          );
        })}
        <FormActions note={offline}>
          {payload && <PrimerButton size="small" variant="invisible" type="button" disabled={saving} onClick={() => {
            setDraft({});
            setErrors({});
            setFormError(undefined);
          }}>Discard changes</PrimerButton>}
          <PrimerButton size="small" variant="primary" type="submit" disabled={saving || Boolean(offline) || !payload}>{saving ? 'Saving…' : 'Save profile'}</PrimerButton>
        </FormActions>
      </form>
    </FormSection>
  );
});

const VISIBILITY: Record<string, string> = {
  public: 'Public: everyone sees your profile.',
  limited: 'Limited: only signed-in users see your profile.',
  private: 'Private: only you and the instance\'s administrators see your profile.',
};

const PrivacySection = observer(function PrivacySection({res, visibility}: {res: Resource<UserSettings>; visibility: string}) {
  const settings = res.value;
  const offline = useOfflineReason('Changing your privacy');
  return (
    <FormSection title="Privacy">
      <SettingRow title="Visibility" description={VISIBILITY[visibility] ?? 'Who sees your profile.'}>
        <ClassicLink to="/user/settings" size="small" variant="default">Change</ClassicLink>
      </SettingRow>
      {settings ? (
        <div className="flex flex-col">
          <Toggle res={res} settings={settings} field="hide_email" label="Hide my email address" hint="Others do not see your primary address on your profile." offline={offline}/>
          <Toggle res={res} settings={settings} field="hide_pronouns" label="Hide my pronouns" hint="Your pronouns are shown to you only." offline={offline}/>
          <Toggle res={res} settings={settings} field="hide_activity" label="Hide my activity" hint="Your activity is not shown on your profile page." offline={offline}/>
          {offline && <p className="text-sm text-muted">{offline}</p>}
        </div>
      ) : <LoadState res={res} what="Your privacy settings" skeleton={<ListSkeleton rows={3} lines={1} leading="none"/>}/>}
    </FormSection>
  );
});
