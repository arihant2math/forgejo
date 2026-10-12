// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {AccountList, AccountRow} from './AccountList.tsx';
import {Banner, SegmentedControl, useFormControlForwardedProps, Avatar, Text, NavList, ToggleSwitch, ConfirmationDialog, Link as PrimerLink, Button as PrimerButton, IconButton, ActionMenu, ActionList, Label, Textarea, TextInput} from '@primer/react';


import {Link} from '@tanstack/react-router';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useId, useRef, useState} from 'react';
import {classicHref} from '../../app/classic.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {notify} from '../../app/notices.ts';
import {connectivity, onlineOnly} from '../../app/online.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {ThemePreference} from '../../app/splash.ts';
import {useApp, useSession} from '../../app/store.ts';
import {setThemePreference, themeState} from '../../app/theme.ts';
import type {APIOption} from '../../protocol/types.gen.ts';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {type Kind, settingsSource, type SettingsSource, type Slot} from './data.ts';
import {FormActions, FormSection, SettingRow} from './form.tsx';
import {Field} from '../../components/Field.tsx';
import {
  type ApiGPGKey, type ApiPublicKey, AVATAR_MAX, diffStyleOf, expired, fieldError, gpgKeyProblem, looksLikeEmail, type Profile, PROFILE_FIELDS, PROFILE_LIMITS,
  type ProfileField, keepUnsaved, profileOf, profilePayload, profileProblems, scopeRefused, type SettingsPatch, shownProfile, sortEmails, spacedKeyId, sshKeyProblem,
  sshKeyTitle, toBase64, type UserSettings,
} from './payload.ts';
import {BrowserIcon, VerifiedIcon, OrganizationIcon, PersonIcon, CloudOfflineIcon, FileSubmoduleIcon, KeyIcon, LockIcon, MailIcon, PaintbrushIcon, PlusIcon, GearIcon, ShieldCheckIcon, TrashIcon, UploadIcon, WebhookIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {Blankslate, SkeletonBox, SkeletonAvatar} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

type Section = 'profile' | 'account' | 'appearance' | 'keys';

const SECTIONS: {id: Section; label: string; icon: OcticonType; to: string; kinds: Kind[]}[] = [
  {id: 'profile', label: 'Public profile', icon: PersonIcon, to: '/user/settings', kinds: ['settings']},
  {id: 'account', label: 'Account', icon: MailIcon, to: '/user/settings/account', kinds: ['emails']},
  {id: 'appearance', label: 'Appearance', icon: PaintbrushIcon, to: '/user/settings/appearance', kinds: ['settings', 'options']},
  {id: 'keys', label: 'SSH and GPG keys', icon: KeyIcon, to: '/user/settings/keys', kinds: ['keys', 'gpg']},
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

function useSource(): SettingsSource {
  const src = settingsSource(useApp());
  if (!src) throw new Error('settings without a session');
  return src;
}

function useLoad(src: SettingsSource, ...kinds: Kind[]): void {
  const key = kinds.join(',');
  useEffect(() => {
    for (const k of key.split(',') as Kind[]) void src.load(k);
  }, [src, key]);
}

function failure(err: unknown): string {
  if (scopeRefused(err)) return 'Forgejo Next may not change your account with this sign-in. Sign out and in again, or change it in the classic UI.';
  return err instanceof Error ? err.message : String(err);
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
          <div className="flex w-full min-w-0 max-w-xl flex-col gap-8 px-4 py-4 @xl:px-8 @xl:py-6"><UserOfflineNote/>{children}</div>
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

const UserOfflineNote = observer(function UserOfflineNote() {
  return connectivity.online ? null : <Banner variant="warning" title="You are offline" description={onlineOnly('Changing account settings')}/>;
});

function SideNav({section}: {section: Section}) {
  const app = useApp();
  const src = useSource();
  return (
    <NavList aria-label="Settings pages" className="shrink-0 @xl:w-64 @xl:self-start">
      {SECTIONS.map((page) => <NavList.Item key={page.id} as={Link} to={page.to} aria-current={page.id === section ? 'page' : false}
        activeOptions={{exact: true}} onPointerEnter={() => { src.prefetch(...page.kinds); }} onFocus={() => { src.prefetch(...page.kinds); }}>
        <NavList.LeadingVisual><page.icon/></NavList.LeadingVisual>{page.label}
      </NavList.Item>)}
      <NavList.Group title="In the classic UI">
        {CLASSIC.map((page) => <NavList.Item key={page.to} href={classicHref(app, page.to)} data-classic="">
          <NavList.LeadingVisual><page.icon/></NavList.LeadingVisual>{page.label}
        </NavList.Item>)}
      </NavList.Group>
    </NavList>
  );
}

function SlotState({slot, what, skeleton}: {slot: Slot<unknown>; what: string; skeleton: ReactNode}) {
  if (slot.state === 'loading') return <>{skeleton}</>;
  if (slot.state === 'offline') return <Blankslate><Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual><Blankslate.Heading>{`${what} are not on this device`}</Blankslate.Heading><Blankslate.Description>Connect to load them.</Blankslate.Description></Blankslate>;
  if (slot.state === 'error') return <Banner variant="critical" title={`${what} could not be loaded`} description={slot.message}/>;
  return null;
}

function RowsSkeleton({rows = 2}: {rows?: number}) {
  return (
    <div aria-busy className="flex flex-col gap-2 py-2">
      {Array.from({length: rows}, (_, i) => <SkeletonBox className="h-3 w-2/3" key={i}/>)}
    </div>
  );
}

function useOffline(action: string): string | undefined {
  return connectivity.online ? undefined : onlineOnly(action);
}


const LABELS: Record<ProfileField, string> = {full_name: 'Name', pronouns: 'Pronouns', website: 'Website', location: 'Location', description: 'Bio'};

const HINTS: Partial<Record<ProfileField, string>> = {
  full_name: 'Shown next to your username.',
  website: 'An http:// or https:// address.',
  description: 'A few words about yourself (markdown).',
};

const ProfileView = observer(function ProfileView() {
  const src = useSource();
  const {data, userId} = useSession();
  useLoad(src, 'settings');
  const user = data.pool.model('User').get(userId);
  const settings = src.value('settings');
  // Settings include private pronouns; the public pool profile is only a fallback.
  const current: Profile = settings ? profileOf(settings) : profileOf({
    full_name: user?.get('full_name') ?? '', pronouns: user?.get('pronouns') ?? '', website: user?.get('website') ?? '',
    location: user?.get('location') ?? '', description: user?.get('description') ?? '',
  });
  return (
    <>
      <AvatarEditor src={src}/>
      <ProfileForm src={src} current={current}/>
      <PrivacySection src={src} settings={settings} slot={src.slot('settings')} visibility={user?.get('visibility') ?? ''}/>
    </>
  );
});

const ProfileForm = observer(function ProfileForm({src, current}: {src: SettingsSource; current: Profile}) {
  const app = useApp();
  const base = useId();
  const [draft, setDraft] = useState<Partial<Profile>>({});
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const offline = useOffline('Saving your profile');
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
    src.patch(payload, false).then(() => {
      // Clear only saved draft values, preserving edits typed during the request.
      setDraft((d) => keepUnsaved(d, payload));
      notify(app, {tone: 'success', title: 'Profile saved'});
    }, (err: unknown) => {
      const fe = fieldError(err);
      const field = PROFILE_FIELDS.find((f) => f === fe.field);
      if (field) {
        setErrors({[field]: fe.message});
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

const AvatarEditor = observer(function AvatarEditor({src}: {src: SettingsSource}) {
  const app = useApp();
  const {data, userId} = useSession();
  const user = data.pool.model('User').get(userId);
  const url = user?.get('avatar_url');
  const login = user?.get('login') ?? '';
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{url: string; was: string | undefined} | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const offline = useOffline('Changing your picture');
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
      return src.uploadAvatar(toBase64(new Uint8Array(buf)));
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
    src.deleteAvatar().then(() => {
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

const PrivacySection = observer(function PrivacySection({src, settings, slot, visibility}: {src: SettingsSource; settings: UserSettings | undefined; slot: Slot<UserSettings>; visibility: string}) {
  const offline = useOffline('Changing your privacy');
  return (
    <FormSection title="Privacy">
      <SettingRow title="Visibility" description={VISIBILITY[visibility] ?? 'Who sees your profile.'}>
        <ClassicLink to="/user/settings" size="small" variant="default">Change</ClassicLink>
      </SettingRow>
      {settings ? (
        <div className="flex flex-col">
          <Toggle src={src} settings={settings} field="hide_email" label="Hide my email address" hint="Others do not see your primary address on your profile." offline={offline}/>
          <Toggle src={src} settings={settings} field="hide_pronouns" label="Hide my pronouns" hint="Your pronouns are shown to you only." offline={offline}/>
          <Toggle src={src} settings={settings} field="hide_activity" label="Hide my activity" hint="Your activity is not shown on your profile page." offline={offline}/>
          {offline && <p className="text-sm text-muted">{offline}</p>}
        </div>
      ) : <SlotState slot={slot} what="Your privacy settings" skeleton={<RowsSkeleton rows={3}/>}/>}
    </FormSection>
  );
});

const Toggle = observer(function Toggle({src, settings, field, label, hint, offline}: {
  src: SettingsSource; settings: UserSettings; field: 'hide_email' | 'hide_pronouns' | 'hide_activity' | 'enable_repo_unit_hints'; label: string; hint: string;
  offline: string | undefined;
}) {
  const change = useChange(src);
  const id = useId();
  return (
    <SettingRow id={id} title={label} description={hint}>
      <ToggleSwitch size="small" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} checked={settings[field]} disabled={Boolean(offline)}
 onChange={(on) => { change({[field]: on}, label); }}/>
    </SettingRow>
  );
});

function useChange(src: SettingsSource): (patch: SettingsPatch, what: string) => void {
  const app = useApp();
  return (patch, what) => {
    src.patch(patch, true).catch((err: unknown) => {
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
  const src = useSource();
  useLoad(src, 'settings', 'options');
  const settings = src.value('settings');
  const options = src.value('options');
  const change = useChange(src);
  const offline = useOffline('Changing the appearance');
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
            <Toggle src={src} settings={settings} field="enable_repo_unit_hints" label="Hints for a repository's unused features"
              hint="The classic UI suggests adding what a repository you own does not use yet (a wiki, releases)." offline={offline}/>
            {offline && <p className="text-sm text-muted">{offline}</p>}
          </>
        ) : <SlotState slot={settings ? src.slot('options') : src.slot('settings')} what="Your appearance settings" skeleton={<RowsSkeleton rows={4}/>}/>}
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
  const src = useSource();
  useLoad(src, 'emails');
  return (
    <>
      <EmailsSection src={src}/>
      <FormSection title="Password" description="Change your password, or set one for an account that signs in elsewhere.">
        <div><ClassicLink size="small" to="/user/settings/account" variant="default">Change your password</ClassicLink></div>
      </FormSection>
      <FormSection title="Delete account" description="Once you delete your account, there is no going back: your repositories, organizations you alone own and everything you wrote go with it.">
        <div><ClassicLink size="small" to="/user/settings/account" variant="danger">Delete your account</ClassicLink></div>
      </FormSection>
    </>
  );
});

const EmailsSection = observer(function EmailsSection({src}: {src: SettingsSource}) {
  const app = useApp();
  const slot = src.slot('emails');
  const offline = useOffline('Changing your email addresses');
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const list = slot.state === 'ready' ? sortEmails(slot.value) : undefined;
  const primary = (email: string) => {
    src.makePrimary(email).then(() => {
      notify(app, {tone: 'success', title: `${email} is your primary address`});
    }, (err: unknown) => {
      notify(app, {tone: 'danger', title: 'The primary address did not change', description: failure(err)});
    });
  };
  const remove = (email: string) => {
    src.deleteEmail(email).catch((err: unknown) => {
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
      ) : <SlotState slot={slot} what="Your email addresses" skeleton={<RowsSkeleton/>}/>}
      {list?.some((e) => !e.verified) && (
        <p className="text-sm text-muted">An unverified address waits for the link Forgejo mailed to it. <TextClassic to="/user/settings/account">Send it again in the classic UI</TextClassic>.</p>
      )}
      <AddEmail src={src} offline={offline}/>
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

const AddEmail = observer(function AddEmail({src, offline}: {src: SettingsSource; offline: string | undefined}) {
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
    src.addEmail(e).then(() => {
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
  const src = useSource();
  useLoad(src, 'keys', 'gpg');
  return (
    <>
      <SshKeys src={src}/>
      <GpgKeys src={src}/>
      <p className="text-sm text-muted">
        Verifying a key, and SSH certificate principals, are in the <TextClassic to="/user/settings/keys">classic UI</TextClassic>.
      </p>
    </>
  );
});

const SshKeys = observer(function SshKeys({src}: {src: SettingsSource}) {
  const app = useApp();
  const slot = src.slot('keys');
  const offline = useOffline('Changing your SSH keys');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ApiPublicKey | undefined>(undefined);
  const list = slot.state === 'ready' ? slot.value : undefined;
  return (
    <FormSection title="SSH keys" description="The keys that may push and pull over SSH as you."
      actions={!adding && <PrimerButton size="small" leadingVisual={PlusIcon} type="button" inactive={Boolean(offline)} onClick={() => {
        setAdding(true);
      }}>New SSH key</PrimerButton>}>
      {adding && <AddSshKey src={src} offline={offline} onDone={() => {
        setAdding(false);
      }}/>}
      {list ? (list.length ? (
        <AccountList title={`${String(list.length)} ${list.length === 1 ? 'key' : 'keys'}`}>
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
        <SlotState slot={slot} what="Your SSH keys" skeleton={<RowsSkeleton/>}/>}
      {removing && (
        <Confirm title={`Delete “${removing.title ?? 'SSH key'}”?`} description="It can no longer push or pull as you." action="Delete key" onConfirm={() => {
          src.deleteKey(removing.id).catch((err: unknown) => {
            notify(app, {tone: 'danger', title: 'The key was not deleted', description: failure(err)});
          });
        }} onClose={() => {
          setRemoving(undefined);
        }}/>
      )}
    </FormSection>
  );
});

const AddSshKey = observer(function AddSshKey({src, offline, onDone}: {src: SettingsSource; offline: string | undefined; onDone: () => void}) {
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
    src.addKey(name, key.trim()).then(() => {
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

const GpgKeys = observer(function GpgKeys({src}: {src: SettingsSource}) {
  const app = useApp();
  const slot = src.slot('gpg');
  const offline = useOffline('Changing your GPG keys');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ApiGPGKey | undefined>(undefined);
  const list = slot.state === 'ready' ? slot.value : undefined;
  return (
    <FormSection title="GPG keys" description="The keys whose signatures mark your commits as verified."
      actions={!adding && <PrimerButton size="small" leadingVisual={PlusIcon} type="button" inactive={Boolean(offline)} onClick={() => {
        setAdding(true);
      }}>New GPG key</PrimerButton>}>
      {adding && <AddGpgKey src={src} offline={offline} onDone={() => {
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
        <SlotState slot={slot} what="Your GPG keys" skeleton={<RowsSkeleton/>}/>}
      {removing && (
        <Confirm title={`Delete the key ${spacedKeyId(removing.key_id)}?`} description="Commits it signed no longer show as verified." action="Delete key" onConfirm={() => {
          src.deleteGpgKey(removing.id).catch((err: unknown) => {
            notify(app, {tone: 'danger', title: 'The key was not deleted', description: failure(err)});
          });
        }} onClose={() => {
          setRemoving(undefined);
        }}/>
      )}
    </FormSection>
  );
});

const AddGpgKey = observer(function AddGpgKey({src, offline, onDone}: {src: SettingsSource; offline: string | undefined; onDone: () => void}) {
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
    src.addGpgKey(key.trim()).then((k) => {
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

