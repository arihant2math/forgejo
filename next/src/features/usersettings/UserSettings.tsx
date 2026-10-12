// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {AccountList, AccountRow} from './AccountList.tsx';
import {Banner, SegmentedControl, Avatar, Text, NavList, ToggleSwitch, ConfirmationDialog, Link as PrimerLink, Button as PrimerButton, IconButton, ActionMenu, ActionList, Label, Textarea, TextInput} from '@primer/react';

import {RouterLinkButton, RouterNavItem} from '../../app/routerLinks.tsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useId, useRef, useState} from 'react';
import {classicHref} from '../../app/classic.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {notify} from '../../app/notices.ts';
import {failureText} from '../../app/api.ts';
import {useOfflineReason} from '../../app/online.ts';
import type {Resource} from '../../app/resource.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {ThemePreference} from '../../app/splash.ts';
import {useApp, useSession} from '../../app/store.ts';
import {setThemePreference, themeState} from '../../app/theme.ts';
import type {APIOption} from '../../protocol/types.gen.ts';
import {ago, fullDate} from '../issues/format.ts';
import {ListSkeleton} from '../../components/ListSkeleton.tsx';
import {LoadState} from '../../components/LoadState.tsx';
import {OfflineBanner} from '../../components/OfflineBanner.tsx';
import {problemOf} from '../settings/problems.ts';
import {
  addEmail, addGpgKey, addKey, deleteAvatar, deleteEmail, deleteGpgKey, deleteKey, makePrimary, patchSettings, uploadAvatar, useUserSettings,
} from './data.ts';
import {describedBy, Field, FormActions, FormSection, SettingRow} from './form.tsx';
import {
  type ApiEmail, type ApiGPGKey, type ApiPublicKey, AVATAR_MAX, diffStyleOf, expired, gpgKeyProblem, looksLikeEmail, type Profile, PROFILE_API_FIELDS, PROFILE_FIELDS, PROFILE_LIMITS,
  type ProfileField, keepUnsaved, profileOf, profilePayload, profileProblems, scopeRefused, type SettingsPatch, shownProfile, sortEmails, spacedKeyId, sshKeyProblem,
  sshKeyTitle, toBase64, type UserSettings,
} from './payload.ts';
import {BrowserIcon, VerifiedIcon, OrganizationIcon, PersonIcon, FileSubmoduleIcon, KeyIcon, LockIcon, MailIcon, PaintbrushIcon, PlusIcon, GearIcon, ShieldCheckIcon, TrashIcon, UploadIcon, WebhookIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Blankslate, SkeletonAvatar} from '@primer/react/experimental';

type Section = 'profile' | 'account' | 'appearance' | 'keys';

const SECTIONS: {id: Section; label: string; icon: OcticonType; to: string}[] = [
  {id: 'profile', label: 'Public profile', icon: PersonIcon, to: '/user/settings'},
  {id: 'account', label: 'Account', icon: MailIcon, to: '/user/settings/account'},
  {id: 'appearance', label: 'Appearance', icon: PaintbrushIcon, to: '/user/settings/appearance'},
  {id: 'keys', label: 'SSH and GPG keys', icon: KeyIcon, to: '/user/settings/keys'},
];

const CLASSIC: {label: string; icon: OcticonType; to: string}[] = [
  {label: 'Security', icon: ShieldCheckIcon, to: '/user/settings/security'},
  {label: 'Applications', icon: BrowserIcon, to: '/user/settings/applications'},
  {label: 'Authorized integrations', icon: VerifiedIcon, to: '/user/settings/authorized-integrations'},
  {label: 'Webhooks', icon: WebhookIcon, to: '/user/settings/hooks'},
  {label: 'Organizations', icon: OrganizationIcon, to: '/user/settings/organization'},
  {label: 'Repositories', icon: FileSubmoduleIcon, to: '/user/settings/repos'},
  {label: 'Blocked users', icon: PersonIcon, to: '/user/settings/blocked_users'},
];

export function SettingsProfile() {
  return <SettingsPage section="profile"><ProfileView/></SettingsPage>;
}

export function SettingsAccount() {
  return <SettingsPage section="account"><AccountView/></SettingsPage>;
}

export function SettingsAppearance() {
  return <SettingsPage section="appearance"><AppearanceView/></SettingsPage>;
}

export function SettingsKeys() {
  return <SettingsPage section="keys"><KeysView/></SettingsPage>;
}

function failure(err: unknown): string {
  if (scopeRefused(err)) return 'Forgejo Next may not change your account with this sign-in. Sign out and in again, or change it in the classic UI.';
  return failureText(err);
}

function SettingsPage({section, children}: {section: Section; children: ReactNode}) {
  const page = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <>
      <PageHeader icon={GearIcon} title="Settings" docTitle={`${page?.label ?? 'Public profile'} · Settings`}>
        <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of the settings">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
          <ClassicMenuItem to={page?.to ?? '/user/settings'} icon={BrowserIcon}>This page</ClassicMenuItem>
        </ActionList></ActionMenu.Overlay></ActionMenu>
      </PageHeader>
      <PageBody>
        <AccountHeader/>
        <div className="flex min-h-full flex-col @xl:flex-row">
          <SideNav section={section}/>
          <div className="flex w-full min-w-0 max-w-xl flex-col gap-8 px-4 py-4 @xl:px-8 @xl:py-6"><OfflineBanner action="Changing account settings"/>{children}</div>
        </div>
      </PageBody>
    </>
  );
}

/** GitHub's settings header: whose settings these are, and the way to their profile. */
const AccountHeader = observer(function AccountHeader() {
  const {data, userId} = useSession();
  const user = data.pool.model('User').get(userId);
  if (!user) return null;
  const login = user.get('login');
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 pt-4 @xl:px-8 @xl:pt-6">
      <Avatar size={48} src={user.get('avatar_url')} alt=""/>
      <div className="flex min-w-0 flex-1 flex-col">
        <Text weight="semibold" className="truncate">{user.get('full_name') || login}{user.get('full_name') ? <span className="font-normal text-muted"> ({login})</span> : null}</Text>
        <span className="text-sm text-muted">Your personal account</span>
      </div>
      <RouterLinkButton size="small" to="/$owner" params={{owner: login}}>Go to your personal profile</RouterLinkButton>
    </div>
  );
});

function SideNav({section}: {section: Section}) {
  const app = useApp();
  // Route loaders prefetch each page's settings on intent.
  return (
    <NavList aria-label="Settings pages" className="shrink-0 @xl:w-64 @xl:self-start">
      {SECTIONS.map((page) => <RouterNavItem key={page.id} to={page.to} aria-current={page.id === section ? 'page' : false} activeOptions={{exact: true}}>
        <NavList.LeadingVisual><page.icon/></NavList.LeadingVisual>{page.label}
      </RouterNavItem>)}
      <NavList.Group title="In the classic UI">
        {CLASSIC.map((page) => <NavList.Item key={page.to} href={classicHref(app, page.to)} data-classic="">
          <NavList.LeadingVisual><page.icon/></NavList.LeadingVisual>{page.label}
        </NavList.Item>)}
      </NavList.Group>
    </NavList>
  );
}


const LABELS: Record<ProfileField, string> = {full_name: 'Name', pronouns: 'Pronouns', website: 'Website', location: 'Location', description: 'Bio'};

const HINTS: Partial<Record<ProfileField, string>> = {
  full_name: 'Shown next to your username.',
  website: 'An http:// or https:// address.',
  description: 'A few words about yourself (markdown).',
};

const ProfileView = observer(function ProfileView() {
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
          const id = `${base}-${f}`;
          const hint = HINTS[f];
          const described = describedBy(id, errors[f], hint !== undefined);
          const max = PROFILE_LIMITS[f] * 2;
          return (
            <Field key={f} id={id} label={LABELS[f]} hint={hint} error={errors[f]}>
              {f === 'description' ?
                <Textarea value={shown[f]} maxLength={max} aria-describedby={described} rows={4} onChange={(e) => {
                  edit(f, e.target.value);
                }} onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    save();
                  }
                }} block {...(errors[f] ? {validationStatus: 'error' as const} : {})}/> :
                <TextInput value={shown[f]} maxLength={max} aria-describedby={described} className="w-full" type={f === 'website' ? 'url' : 'text'} inputMode={f === 'website' ? 'url' : undefined} onChange={(e) => {
                  edit(f, e.target.value);
                }} {...(errors[f] ? {validationStatus: 'error' as const} : {})}/>}
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

const AvatarEditor = observer(function AvatarEditor() {
  const app = useApp();
  const {data, userId} = useSession();
  const user = data.pool.model('User').get(userId);
  const url = user?.get('avatar_url');
  const login = user?.get('login') ?? '';
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{url: string; was: string | undefined} | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const offline = useOfflineReason('Changing your picture');
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);
  const shown = preview && preview.was === url ? preview.url : url;
  const upload = (file: File) => {
    setError(undefined);
    if (!file.type.startsWith('image/')) {
      setError('Choose an image (PNG, JPEG, GIF or WebP).');
      return;
    }
    if (file.size > AVATAR_MAX) {
      setError('This picture is too large.');
      return;
    }
    setBusy(true);
    file.arrayBuffer().then((buf) => {
      setPreview({url: URL.createObjectURL(file), was: url});
      return uploadAvatar(app, toBase64(new Uint8Array(buf)));
    }).then(() => {
      notify(app, {tone: 'success', title: 'Picture changed'});
    }, (err: unknown) => {
      setPreview(undefined);
      setError(failure(err));
    }).finally(() => {
      setBusy(false);
    });
  };
  const remove = () => {
    setError(undefined);
    setBusy(true);
    deleteAvatar(app).then(() => {
      setPreview(undefined);
      notify(app, {tone: 'success', title: 'Picture removed'});
    }, (err: unknown) => {
      setError(failure(err));
    }).finally(() => {
      setBusy(false);
    });
  };
  return (
    <FormSection title="Profile picture">
      <div className="flex flex-wrap items-center gap-4">
        {shown ? <Avatar size={96} alt={login} src={shown}/> : <SkeletonAvatar size={96}/>}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <PrimerButton size="small" leadingVisual={UploadIcon} type="button" disabled={busy || Boolean(offline)} onClick={() => input.current?.click()}>{busy ? 'Saving…' : 'Upload a picture'}</PrimerButton>
            <PrimerButton size="small" variant="invisible" leadingVisual={TrashIcon} type="button" disabled={busy || Boolean(offline)} onClick={remove}>Remove</PrimerButton>
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <p className="text-sm text-muted">{offline ?? 'A square picture looks best.'}</p>}
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) upload(file);
        }}/>
      </div>
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

const Toggle = observer(function Toggle({res, settings, field, label, hint, offline}: {
  res: Resource<UserSettings>; settings: UserSettings; field: 'hide_email' | 'hide_pronouns' | 'hide_activity' | 'enable_repo_unit_hints'; label: string; hint: string;
  offline: string | undefined;
}) {
  const change = useChange(res);
  const id = useId();
  return (
    <SettingRow id={id} title={label} description={hint}>
      <ToggleSwitch size="small" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} checked={settings[field]} disabled={Boolean(offline)}
 onChange={(on) => { change({[field]: on}, label); }}/>
    </SettingRow>
  );
});

function useChange(res: Resource<UserSettings>): (patch: SettingsPatch, what: string) => void {
  const app = useApp();
  return (patch, what) => {
    patchSettings(app, res, patch, true).catch((err: unknown) => {
      notify(app, {tone: 'danger', title: `${what}: not saved`, description: failure(err)});
    });
  };
}


const NEXT_THEMES: {value: ThemePreference; label: string}[] = [
  {value: 'system', label: 'System'},
  {value: 'light', label: 'Light'},
  {value: 'dark', label: 'Dark'},
];

const AppearanceView = observer(function AppearanceView() {
  const settingsRes = useUserSettings('settings');
  const optionsRes = useUserSettings('options');
  const settings = settingsRes.value;
  const options = optionsRes.value;
  const change = useChange(settingsRes);
  const offline = useOfflineReason('Changing the appearance');
  return (
    <>
      <FormSection title="Forgejo Next" description="How this app looks on this device.">
        <SettingRow title="Theme" description="System follows your device's light or dark mode.">
          <SegmentedControl size="small" aria-label="Theme" onChange={(index) => {
            const theme = NEXT_THEMES[index ?? -1];
            if (theme) setThemePreference(theme.value);
          }}>{NEXT_THEMES.map((theme) => <SegmentedControl.Button key={theme.value} selected={themeState.preference === theme.value}>{theme.label}</SegmentedControl.Button>)}</SegmentedControl>
        </SettingRow>
      </FormSection>
      <FormSection title="Your account" description="Saved with your account: the classic UI and Forgejo's emails use them.">
        {settings && options ? (
          <>
            <SettingRow title="Language" description="Of the classic UI and the emails Forgejo sends you.">
              <ChoiceMenu label="Language" value={settings.language} options={options.languages} fallback="Default" disabled={offline} onChange={(v) => {
                change({language: v}, 'Language');
              }}/>
            </SettingRow>
            <SettingRow title="Classic UI theme">
              <ChoiceMenu label="Classic UI theme" value={settings.theme || options.default_theme} options={options.themes} disabled={offline} onChange={(v) => {
                change({theme: v}, 'Theme');
              }}/>
            </SettingRow>
            <SettingRow title="Diff view" description="How the classic UI shows a change.">
              {offline ? <span className="text-sm text-muted">{diffStyleOf(settings.diff_view_style) === 'split' ? 'Split' : 'Unified'}</span> :
                <SegmentedControl size="small" aria-label="Diff view" onChange={(index) => {
                  if (index !== undefined) change({diff_view_style: index === 0 ? 'unified' : 'split'}, 'Diff view');
                }}><SegmentedControl.Button selected={diffStyleOf(settings.diff_view_style) === 'unified'}>Unified</SegmentedControl.Button><SegmentedControl.Button selected={diffStyleOf(settings.diff_view_style) === 'split'}>Split</SegmentedControl.Button></SegmentedControl>}
            </SettingRow>
            <Toggle res={settingsRes} settings={settings} field="enable_repo_unit_hints" label="Hints for a repository's unused features"
              hint="The classic UI suggests adding what a repository you own does not use yet (a wiki, releases)." offline={offline}/>
            {offline && <p className="text-sm text-muted">{offline}</p>}
          </>
        ) : <LoadState res={settings ? optionsRes : settingsRes} what="Your appearance settings" skeleton={<ListSkeleton rows={4} lines={1} leading="none"/>}/>}
      </FormSection>
    </>
  );
});

function ChoiceMenu({label, value, options, fallback, disabled, onChange}: {
  label: string; value: string; options: APIOption[]; fallback?: string; disabled: string | undefined; onChange: (v: string) => void;
}) {
  const name = options.find((o) => o.id === value)?.name ?? (value !== '' ? value : fallback ?? '—');
  return (
    <ActionMenu>
      <ActionMenu.Button size="small" aria-label={`${label}: ${name}`} inactive={Boolean(disabled)}>{name}</ActionMenu.Button>
      <ActionMenu.Overlay align="end"><ActionList>
        <ActionList.Group selectionVariant="single">
          {options.map((o) => <ActionList.Item key={o.id} selected={value === o.id} onSelect={() => {
            if (o.id !== value) onChange(o.id);
          }}>{o.name}</ActionList.Item>)}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}


const AccountView = observer(function AccountView() {
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
        <AccountList title={`${String(list.length)} ${list.length === 1 ? 'address' : 'addresses'}`}>
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

const AddEmail = observer(function AddEmail({res, offline}: {res: Resource<ApiEmail[]>; offline: string | undefined}) {
  const app = useApp();
  const id = useId();
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
      <Field id={id} label="Add an email address" error={error} hint={offline}>
        <div className="flex gap-2">
          <TextInput type="email" autoComplete="email" placeholder="you@example.com" value={email} className="min-w-0 flex-1" aria-describedby={describedBy(id, error, Boolean(offline))} onChange={(e) => {
              setEmail(e.target.value);
              setError(undefined);
            }} {...(error ? {validationStatus: 'error' as const} : {})}/>
          <PrimerButton size="small" leadingVisual={PlusIcon} type="submit" disabled={saving || Boolean(offline) || !email.trim()}>{saving ? 'Adding…' : 'Add'}</PrimerButton>
        </div>
      </Field>
    </form>
  );
});

function TextClassic({to, children}: {to: string; children: ReactNode}) {
  const app = useApp();
  return <PrimerLink href={classicHref(app, to)} data-classic="">{children}</PrimerLink>;
}

function Confirm({title, description, action, onConfirm, onClose}: {title: string; description: ReactNode; action: string; onConfirm: () => void; onClose: () => void}) {
  return (
    <ConfirmationDialog title={title} confirmButtonContent={action} confirmButtonType="danger" onClose={(gesture) => {
      onClose();
      if (gesture === 'confirm') onConfirm();
    }}>{description}</ConfirmationDialog>
  );
}


const KeysView = observer(function KeysView() {
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
        <AccountList title={`${String(list.length)} ${list.length === 1 ? 'key' : 'keys'}`}>
          {list.map((k) => (
            <AccountRow key={k.id} leading={<KeyIcon size={16} className="shrink-0"/>} trailing={<>
              {k.verified && <Label variant="success">Verified</Label>}
              <time dateTime={k.created_at} title={`Added ${fullDate(k.created_at)}`}>{ago(k.created_at)}</time>
              <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={`Delete ${k.title ?? 'this key'}`} type="button" disabled={Boolean(offline)} onClick={() => {
                setRemoving(k);
              }}/>
            </>}>
              <span className="font-semibold">{k.title}</span>
              {k.fingerprint && <code className="ml-4 text-sm text-muted" title={k.fingerprint}>{k.fingerprint}</code>}
            </AccountRow>
          ))}
        </AccountList>
      ) : !adding && <Blankslate><Blankslate.Visual><KeyIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No SSH keys</Blankslate.Heading><Blankslate.Description>Add one to push and pull over SSH.</Blankslate.Description></Blankslate>) :
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
  const base = useId();
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
      <Field id={`${base}-title`} label="Title" hint="Optional: the key's comment, else its type.">
        <TextInput value={title} className="w-full" maxLength={255} placeholder="Laptop" aria-describedby={`${base}-title-hint`} onChange={(e) => {
          setTitle(e.target.value);
        }}/>
      </Field>
      <Field id={`${base}-key`} label="Key" hint="Your public key: the contents of ~/.ssh/id_ed25519.pub, for example." error={error}>
        <Textarea value={key} rows={4} autoFocus spellCheck={false} placeholder="ssh-ed25519 AAAA… you@example.com" aria-describedby={describedBy(`${base}-key`, error, true)} onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }} block {...(error ? {validationStatus: 'error' as const} : {})}/>
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
        <AccountList title={`${String(list.length)} ${list.length === 1 ? 'key' : 'keys'}`}>
          {list.map((k) => {
            const emails = (k.emails ?? []).map((e) => e.email).join(', ');
            return (
              <AccountRow key={k.id} leading={<LockIcon size={16} className="shrink-0"/>} trailing={<>
                {k.verified ? <Label variant="success">Verified</Label> : <Label>Unverified</Label>}
                {expired(k.expires_at) && <Label variant="attention">Expired</Label>}
                <time dateTime={k.created_at} title={`Added ${fullDate(k.created_at)}`}>{ago(k.created_at)}</time>
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
      ) : !adding && <Blankslate><Blankslate.Visual><LockIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No GPG keys</Blankslate.Heading><Blankslate.Description>Add one to have your signed commits verified.</Blankslate.Description></Blankslate>) :
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
  const id = useId();
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
      <Field id={id} label="Key" hint="The output of gpg --armor --export <key id>." error={error}>
        <Textarea value={key} rows={6} autoFocus spellCheck={false} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" aria-describedby={describedBy(id, error, true)} onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }} block {...(error ? {validationStatus: 'error' as const} : {})}/>
      </Field>
      <FormActions note={offline}>
        <PrimerButton size="small" variant="invisible" type="button" onClick={onDone}>Cancel</PrimerButton>
        <PrimerButton size="small" variant="primary" type="submit" disabled={saving || Boolean(offline) || !key.trim()}>{saving ? 'Adding…' : 'Add GPG key'}</PrimerButton>
      </FormActions>
    </form>
  );
});

