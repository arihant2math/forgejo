// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's settings (the classic /user/settings pages at their own
// addresses, laid out like GitHub's settings): a side list of the pages
// beside the page — Profile, Account (email addresses), Appearance, SSH and
// GPG keys here, the other pages in the classic UI. The profile paints from
// the pool's User at once; the rest comes from API v1, kept in the code
// cache (data.ts). Writes are online only. Its own chunk.

import {Link} from '@tanstack/react-router';
import {
  AppWindow, BadgeCheck, Building2, ChevronDown, CircleUser, CloudOff, FolderGit2, KeyRound, LockKeyhole, Mail, Palette, Plus, Settings,
  ShieldCheck, Trash2, Upload, UserX, Webhook,
} from 'lucide-react';
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
import {
  Avatar, Badge, Button, Callout, Checkbox, Dialog, EmptyState, Icon, IconButton, Input, ListRow, type LucideIcon, Menu, MenuContent, MenuRadioGroup,
  MenuRadioItem, MenuTrigger, MoreMenu, NavHeading, NavItem, Panel, SegmentedControl, Skeleton, TextArea,
} from '../../ui/index.ts';
import {ago, fullDate} from '../issues/format.ts';
import {type Kind, settingsSource, type SettingsSource, type Slot} from './data.ts';
import {describedBy, Field, FormActions, FormSection, SettingRow} from './form.tsx';
import {
  type ApiGPGKey, type ApiPublicKey, AVATAR_MAX, diffStyleOf, expired, fieldError, gpgKeyProblem, looksLikeEmail, type Profile, PROFILE_FIELDS, PROFILE_LIMITS,
  type ProfileField, keepUnsaved, profileOf, profilePayload, profileProblems, scopeRefused, type SettingsPatch, shownProfile, sortEmails, spacedKeyId, sshKeyProblem,
  sshKeyTitle, toBase64, type UserSettings,
} from './payload.ts';

type Section = 'profile' | 'account' | 'appearance' | 'keys';

const SECTIONS: {id: Section; label: string; icon: LucideIcon; to: string; kinds: Kind[]}[] = [
  {id: 'profile', label: 'Profile', icon: CircleUser, to: '/user/settings', kinds: ['settings']},
  {id: 'account', label: 'Account', icon: Mail, to: '/user/settings/account', kinds: ['emails']},
  {id: 'appearance', label: 'Appearance', icon: Palette, to: '/user/settings/appearance', kinds: ['settings', 'options']},
  {id: 'keys', label: 'SSH and GPG keys', icon: KeyRound, to: '/user/settings/keys', kinds: ['keys', 'gpg']},
];

/** The settings pages only the classic UI has (its settings menu, less what depends on the instance's features). */
const CLASSIC: {label: string; icon: LucideIcon; to: string}[] = [
  {label: 'Security', icon: ShieldCheck, to: '/user/settings/security'},
  {label: 'Applications', icon: AppWindow, to: '/user/settings/applications'},
  {label: 'Authorized integrations', icon: BadgeCheck, to: '/user/settings/authorized-integrations'},
  {label: 'Webhooks', icon: Webhook, to: '/user/settings/hooks'},
  {label: 'Organizations', icon: Building2, to: '/user/settings/organization'},
  {label: 'Repositories', icon: FolderGit2, to: '/user/settings/repos'},
  {label: 'Blocked users', icon: UserX, to: '/user/settings/blocked_users'},
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

/** Loads what a page shows when it opens (the device's copy at once, then Forgejo). */
function useLoad(src: SettingsSource, ...kinds: Kind[]): void {
  const key = kinds.join(',');
  useEffect(() => {
    for (const k of key.split(',') as Kind[]) void src.load(k);
  }, [src, key]);
}

/** A write's failure in words (the token's scope named when that is why). */
function failure(err: unknown): string {
  if (scopeRefused(err)) return 'Forgejo Next may not change your account with this sign-in. Sign out and in again, or change it in the classic UI.';
  return err instanceof Error ? err.message : String(err);
}

/** Every settings page: the header, the side list of pages, the page. */
function SettingsPage({section, children}: {section: Section; children: ReactNode}) {
  const page = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <>
      <PageHeader icon={Settings} title="Settings" docTitle={`${page?.label ?? 'Profile'} · Settings`}>
        <MoreMenu label="More of the settings">
          <ClassicMenuItem to={page?.to ?? '/user/settings'} icon={AppWindow}>This page</ClassicMenuItem>
        </MoreMenu>
      </PageHeader>
      <PageBody>
        <div className="flex min-h-full flex-col @xl:flex-row">
          <SideNav section={section}/>
          <div className="flex w-full min-w-0 max-w-lg flex-col gap-8 px-4 py-4 @xl:px-8 @xl:py-6">{children}</div>
        </div>
      </PageBody>
    </>
  );
}

/** The settings pages (GitHub's settings list). Pointing at one starts loading what it shows. */
function SideNav({section}: {section: Section}) {
  const app = useApp();
  const src = useSource();
  return (
    <nav aria-label="Settings pages" className="flex shrink-0 flex-col gap-px border-b border-border p-2 @xl:sticky @xl:top-0 @xl:w-pane @xl:self-start @xl:border-r @xl:border-b-0">
      {SECTIONS.map((s) => (
        <NavItem key={s.id} asChild icon={s.icon} label={s.label} onPointerEnter={() => {
          src.prefetch(...s.kinds);
        }} onFocus={() => {
          src.prefetch(...s.kinds);
        }}>
          <Link to={s.to} aria-current={s.id === section ? 'page' : undefined} activeProps={{}} activeOptions={{exact: true}}/>
        </NavItem>
      ))}
      <NavHeading>In the classic UI</NavHeading>
      {CLASSIC.map((c) => (
        <NavItem key={c.to} asChild icon={c.icon} label={c.label}>
          <a href={classicHref(app, c.to)} data-classic=""/>
        </NavItem>
      ))}
    </nav>
  );
}

/** What a page shows while a slot has nothing yet, or why it has nothing. */
function SlotState({slot, what, skeleton}: {slot: Slot<unknown>; what: string; skeleton: ReactNode}) {
  if (slot.state === 'loading') return <>{skeleton}</>;
  if (slot.state === 'offline') return <EmptyState icon={CloudOff} title={`${what} are not on this device`} description="Connect to load them."/>;
  if (slot.state === 'error') return <Callout tone="danger" title={`${what} could not be loaded`}>{slot.message}</Callout>;
  return null;
}

function RowsSkeleton({rows = 2}: {rows?: number}) {
  return (
    <div aria-busy className="flex flex-col gap-3 py-1">
      {Array.from({length: rows}, (_, i) => <Skeleton key={i} className="h-3 w-2/3"/>)}
    </div>
  );
}

/** Why a write cannot be done now, or undefined (online). */
function useOffline(action: string): string | undefined {
  return connectivity.online ? undefined : onlineOnly(action);
}

// ---- Profile ----

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
  // The pool's User paints first (what everyone sees), the settings replace it when they arrive (private pronouns).
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
      // What was saved is the current value now; an edit typed meanwhile stays a draft.
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
        {formError !== undefined && <Callout tone="danger" title="Not saved">{formError}</Callout>}
        {PROFILE_FIELDS.map((f) => {
          const id = `${base}-${f}`;
          const hint = HINTS[f];
          const described = describedBy(id, errors[f], hint !== undefined);
          const max = PROFILE_LIMITS[f] * 2;
          return (
            <Field key={f} id={id} label={LABELS[f]} hint={hint} error={errors[f]}>
              {f === 'description' ?
                <TextArea id={id} value={shown[f]} invalid={Boolean(errors[f])} maxLength={max} aria-describedby={described} rows={4} onChange={(e) => {
                  edit(f, e.target.value);
                }} onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    save();
                  }
                }}/> :
                <Input id={id} value={shown[f]} invalid={Boolean(errors[f])} maxLength={max} aria-describedby={described} className="w-full" type={f === 'website' ? 'url' : 'text'} inputMode={f === 'website' ? 'url' : undefined} onChange={(e) => {
                  edit(f, e.target.value);
                }}/>}
            </Field>
          );
        })}
        <FormActions note={offline}>
          {payload && <Button variant="ghost" disabled={saving} onClick={() => {
            setDraft({});
            setErrors({});
            setFormError(undefined);
          }}>Discard changes</Button>}
          <Button type="submit" variant="primary" disabled={saving || Boolean(offline) || !payload}>{saving ? 'Saving…' : 'Save profile'}</Button>
        </FormActions>
      </form>
    </FormSection>
  );
});

/** The profile picture: the pool's, a new one shown at once while it uploads (until the pool brings its address). */
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
        <Avatar size="xl" name={login} src={shown}/>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button icon={Upload} disabled={busy || Boolean(offline)} onClick={() => input.current?.click()}>{busy ? 'Saving…' : 'Upload a picture'}</Button>
            <Button variant="ghost" icon={Trash2} disabled={busy || Boolean(offline)} onClick={remove}>Remove</Button>
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : <p className="text-sm text-fg-subtle">{offline ?? 'A square picture looks best.'}</p>}
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
        <ClassicLink to="/user/settings" size="sm" variant="secondary">Change</ClassicLink>
      </SettingRow>
      {settings ? (
        <div className="flex flex-col gap-3">
          <Toggle src={src} settings={settings} field="hide_email" label="Hide my email address" hint="Others do not see your primary address on your profile." offline={offline}/>
          <Toggle src={src} settings={settings} field="hide_pronouns" label="Hide my pronouns" hint="Your pronouns are shown to you only." offline={offline}/>
          <Toggle src={src} settings={settings} field="hide_activity" label="Hide my activity" hint="Your activity is not shown on your profile page." offline={offline}/>
          {offline && <p className="text-sm text-fg-subtle">{offline}</p>}
        </div>
      ) : <SlotState slot={slot} what="Your privacy settings" skeleton={<RowsSkeleton rows={3}/>}/>}
    </FormSection>
  );
});

/** A yes/no setting: changed at once, put back when Forgejo refuses. */
const Toggle = observer(function Toggle({src, settings, field, label, hint, offline}: {
  src: SettingsSource; settings: UserSettings; field: 'hide_email' | 'hide_pronouns' | 'hide_activity' | 'enable_repo_unit_hints'; label: string; hint: string;
  offline: string | undefined;
}) {
  const change = useChange(src);
  return (
    <div className="flex flex-col gap-0.5">
      <Checkbox label={label} checked={settings[field]} disabled={Boolean(offline)} onChange={(v) => {
        change({[field]: v}, label);
      }}/>
      <span className="pl-6 text-sm text-fg-subtle">{hint}</span>
    </div>
  );
});

/** An optimistic settings change; a refusal is put back and said. */
function useChange(src: SettingsSource): (patch: SettingsPatch, what: string) => void {
  const app = useApp();
  return (patch, what) => {
    src.patch(patch, true).catch((err: unknown) => {
      notify(app, {tone: 'danger', title: `${what}: not saved`, description: failure(err)});
    });
  };
}

// ---- Appearance ----

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
          <SegmentedControl label="Theme" value={themeState.preference} options={NEXT_THEMES} onChange={setThemePreference}/>
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
              {offline ? <span className="text-sm text-fg-muted">{diffStyleOf(settings.diff_view_style) === 'split' ? 'Split' : 'Unified'}</span> :
                <SegmentedControl label="Diff view" value={diffStyleOf(settings.diff_view_style)} options={[{value: 'unified', label: 'Unified'}, {value: 'split', label: 'Split'}]}
                  onChange={(v) => {
                    change({diff_view_style: v}, 'Diff view');
                  }}/>}
            </SettingRow>
            <Toggle src={src} settings={settings} field="enable_repo_unit_hints" label="Hints for a repository's unused features"
              hint="The classic UI suggests adding what a repository you own does not use yet (a wiki, releases)." offline={offline}/>
            {offline && <p className="text-sm text-fg-subtle">{offline}</p>}
          </>
        ) : <SlotState slot={settings ? src.slot('options') : src.slot('settings')} what="Your appearance settings" skeleton={<RowsSkeleton rows={4}/>}/>}
      </FormSection>
    </>
  );
});

/** One of the instance's choices (a theme, a language), in a menu. */
function ChoiceMenu({label, value, options, fallback, disabled, onChange}: {
  label: string; value: string; options: APIOption[]; fallback?: string; disabled: string | undefined; onChange: (v: string) => void;
}) {
  const name = options.find((o) => o.id === value)?.name ?? (value !== '' ? value : fallback ?? '—');
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" aria-label={`${label}: ${name}`} disabled={Boolean(disabled)} tooltip={disabled}>{name}<Icon icon={ChevronDown} size="sm"/></Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuRadioGroup value={value} onValueChange={(v) => {
          if (v !== value) onChange(v);
        }}>
          {options.map((o) => <MenuRadioItem key={o.id} value={o.id}>{o.name}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

// ---- Account ----

const AccountView = observer(function AccountView() {
  const src = useSource();
  useLoad(src, 'emails');
  return (
    <>
      <EmailsSection src={src}/>
      <FormSection title="Password" description="Change your password, or set one for an account that signs in elsewhere.">
        <div><ClassicLink to="/user/settings/account" variant="secondary">Change your password</ClassicLink></div>
      </FormSection>
      <FormSection title="Delete your account" description="Your repositories, organizations you alone own and everything you wrote go with it.">
        <div><ClassicLink to="/user/settings/account" variant="secondary">Delete your account</ClassicLink></div>
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
        <Panel title={`${String(list.length)} ${list.length === 1 ? 'address' : 'addresses'}`}>
          {list.map((e) => (
            <ListRow key={e.email} role={undefined} leading={<Icon icon={Mail} size="sm"/>} trailing={<>
              {e.primary && <Badge tone="accent">Primary</Badge>}
              {e.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}
              {!e.primary && e.verified && <Button size="sm" variant="ghost" disabled={Boolean(offline)} tooltip={offline} onClick={() => {
                primary(e.email);
              }}>Make primary</Button>}
              {!e.primary && <IconButton size="sm" icon={Trash2} label={`Remove ${e.email}`} disabled={Boolean(offline)} onClick={() => {
                setRemoving(e.email);
              }}/>}
            </>}>
              <span title={e.email}>{e.email}</span>
            </ListRow>
          ))}
        </Panel>
      ) : <SlotState slot={slot} what="Your email addresses" skeleton={<RowsSkeleton/>}/>}
      {list?.some((e) => !e.verified) && (
        <p className="text-sm text-fg-subtle">An unverified address waits for the link Forgejo mailed to it. <TextClassic to="/user/settings/account">Send it again in the classic UI</TextClassic>.</p>
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

const AddEmail = observer(function AddEmail({src, offline}: {src: SettingsSource; offline: string | undefined}) {
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
      <Field id={id} label="Add an email address" error={error} hint={offline}>
        <div className="flex gap-2">
          <Input id={id} type="email" autoComplete="email" placeholder="you@example.com" value={email} invalid={Boolean(error)} className="min-w-0 flex-1"
            aria-describedby={describedBy(id, error, Boolean(offline))} onChange={(e) => {
              setEmail(e.target.value);
              setError(undefined);
            }}/>
          <Button type="submit" icon={Plus} disabled={saving || Boolean(offline) || !email.trim()}>{saving ? 'Adding…' : 'Add'}</Button>
        </div>
      </Field>
    </form>
  );
});

/** A link to a classic page inside a sentence. */
function TextClassic({to, children}: {to: string; children: ReactNode}) {
  const app = useApp();
  return <a href={classicHref(app, to)} data-classic="" className="text-accent-fg hover:underline">{children}</a>;
}

/** Asks before a delete. */
function Confirm({title, description, action, onConfirm, onClose}: {title: string; description: ReactNode; action: string; onConfirm: () => void; onClose: () => void}) {
  return (
    <Dialog open size="sm" title={title} description={description} initialFocus="dialog" onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" onClick={() => {
        onClose();
        onConfirm();
      }}>{action}</Button>
    </>}/>
  );
}

// ---- Keys ----

const KeysView = observer(function KeysView() {
  const src = useSource();
  useLoad(src, 'keys', 'gpg');
  return (
    <>
      <SshKeys src={src}/>
      <GpgKeys src={src}/>
      <p className="text-sm text-fg-subtle">
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
      actions={!adding && <Button size="sm" icon={Plus} disabled={Boolean(offline)} tooltip={offline} onClick={() => {
        setAdding(true);
      }}>New SSH key</Button>}>
      {adding && <AddSshKey src={src} offline={offline} onDone={() => {
        setAdding(false);
      }}/>}
      {list ? (list.length ? (
        <Panel title={`${String(list.length)} ${list.length === 1 ? 'key' : 'keys'}`}>
          {list.map((k) => (
            <ListRow key={k.id} role={undefined} leading={<Icon icon={KeyRound} size="sm"/>} trailing={<>
              {k.verified && <Badge tone="success">Verified</Badge>}
              <time dateTime={k.created_at} title={`Added ${fullDate(k.created_at)}`}>{ago(k.created_at)}</time>
              <IconButton size="sm" icon={Trash2} label={`Delete ${k.title ?? 'this key'}`} disabled={Boolean(offline)} onClick={() => {
                setRemoving(k);
              }}/>
            </>}>
              <span className="font-medium">{k.title}</span>
              {k.fingerprint && <span className="ml-3 font-mono text-sm text-fg-subtle" title={k.fingerprint}>{k.fingerprint}</span>}
            </ListRow>
          ))}
        </Panel>
      ) : !adding && <EmptyState icon={KeyRound} title="No SSH keys" description="Add one to push and pull over SSH."/>) :
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
    src.addKey(name, key.trim()).then(() => {
      notify(app, {tone: 'success', title: `Added the SSH key “${name}”`});
      onDone();
    }, (err: unknown) => {
      setError(failure(err));
      setSaving(false);
    });
  };
  return (
    <form className="flex flex-col gap-3 rounded-md border border-border p-3" onSubmit={(e) => {
      e.preventDefault();
      add();
    }}>
      <Field id={`${base}-title`} label="Title" hint="Optional: the key's comment, else its type.">
        <Input id={`${base}-title`} value={title} className="w-full" maxLength={255} placeholder="Laptop" aria-describedby={`${base}-title-hint`} onChange={(e) => {
          setTitle(e.target.value);
        }}/>
      </Field>
      <Field id={`${base}-key`} label="Key" hint="Your public key: the contents of ~/.ssh/id_ed25519.pub, for example." error={error}>
        <TextArea id={`${base}-key`} value={key} rows={4} autoFocus spellCheck={false} invalid={Boolean(error)} placeholder="ssh-ed25519 AAAA… you@example.com"
          aria-describedby={describedBy(`${base}-key`, error, true)} onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }}/>
      </Field>
      <FormActions note={offline}>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving || Boolean(offline) || !key.trim()}>{saving ? 'Adding…' : 'Add SSH key'}</Button>
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
      actions={!adding && <Button size="sm" icon={Plus} disabled={Boolean(offline)} tooltip={offline} onClick={() => {
        setAdding(true);
      }}>New GPG key</Button>}>
      {adding && <AddGpgKey src={src} offline={offline} onDone={() => {
        setAdding(false);
      }}/>}
      {list ? (list.length ? (
        <Panel title={`${String(list.length)} ${list.length === 1 ? 'key' : 'keys'}`}>
          {list.map((k) => {
            const emails = (k.emails ?? []).map((e) => e.email).join(', ');
            return (
              <ListRow key={k.id} role={undefined} leading={<Icon icon={LockKeyhole} size="sm"/>} trailing={<>
                {k.verified ? <Badge tone="success">Verified</Badge> : <Badge>Unverified</Badge>}
                {expired(k.expires_at) && <Badge tone="warning">Expired</Badge>}
                <time dateTime={k.created_at} title={`Added ${fullDate(k.created_at)}`}>{ago(k.created_at)}</time>
                <IconButton size="sm" icon={Trash2} label={`Delete the key ${k.key_id}`} disabled={Boolean(offline)} onClick={() => {
                  setRemoving(k);
                }}/>
              </>}>
                <span className="font-mono font-medium">{spacedKeyId(k.key_id)}</span>
                {emails && <span className="ml-3 text-fg-subtle" title={emails}>{emails}</span>}
              </ListRow>
            );
          })}
        </Panel>
      ) : !adding && <EmptyState icon={LockKeyhole} title="No GPG keys" description="Add one to have your signed commits verified."/>) :
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
    src.addGpgKey(key.trim()).then((k) => {
      notify(app, {tone: 'success', title: `Added the GPG key ${spacedKeyId(k.key_id)}`});
      onDone();
    }, (err: unknown) => {
      setError(failure(err));
      setSaving(false);
    });
  };
  return (
    <form className="flex flex-col gap-3 rounded-md border border-border p-3" onSubmit={(e) => {
      e.preventDefault();
      add();
    }}>
      <Field id={id} label="Key" hint="The output of gpg --armor --export <key id>." error={error}>
        <TextArea id={id} value={key} rows={6} autoFocus spellCheck={false} invalid={Boolean(error)} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
          aria-describedby={describedBy(id, error, true)} onChange={(e) => {
            setKey(e.target.value);
            setError(undefined);
          }}/>
      </Field>
      <FormActions note={offline}>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving || Boolean(offline) || !key.trim()}>{saving ? 'Adding…' : 'Add GPG key'}</Button>
      </FormActions>
    </form>
  );
});

