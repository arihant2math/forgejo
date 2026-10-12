// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon as OcticonType} from '@primer/octicons-react';
import {BrowserIcon, FileSubmoduleIcon, GearIcon, KebabHorizontalIcon, KeyIcon, MailIcon, OrganizationIcon, PaintbrushIcon, PersonIcon, ShieldCheckIcon, VerifiedIcon, WebhookIcon} from '@primer/octicons-react';
import {ActionList, ActionMenu, Avatar, NavList, Text} from '@primer/react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {classicHref} from '../../app/classic.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {RouterLinkButton, RouterNavItem} from '../../app/routerLinks.tsx';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {OfflineBanner} from '../../components/OfflineBanner.tsx';
import {AccountView} from './Account.tsx';
import {AppearanceView} from './Appearance.tsx';
import {KeysView} from './Keys.tsx';
import {ProfileView} from './Profile.tsx';

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
