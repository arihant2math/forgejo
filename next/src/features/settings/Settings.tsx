// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's settings (/{owner}/{repo}/settings[/collaboration|branches|
// hooks|keys], the classic UI's addresses), laid out like GitHub's: the
// sections on the left, the section's forms on the right. Administrators
// only: anyone else gets the refusal (a site administrator, who has no
// Access rows in the pool, waits for API v1's answer instead of seeing it
// flash). The sections the app does not have yet link to the classic UI.
// Writes are online only (PLAN §5.4). Its own chunk.

import {createLink} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {accessKnown, repoAccess} from '../../app/access.ts';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {connectivity} from '../../app/online.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {NavList} from '@primer/react';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {OfflineNote} from './bits.tsx';
import {BranchSettings} from './Branches.tsx';
import {CollaboratorSettings} from './Collaborators.tsx';
import {GeneralSettings} from './General.tsx';
import {HookSettings} from './Hooks.tsx';
import {KeySettings} from './Keys.tsx';
import {BrowserIcon, GitBranchIcon, KeyIcon, LockIcon, GearIcon, PeopleIcon, WebhookIcon} from '@primer/octicons-react';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {Blankslate, SkeletonBox, SkeletonText} from '@primer/react/experimental';

const SettingsNavItem = createLink(NavList.Item);

export type SettingsSection = 'general' | 'collaboration' | 'branches' | 'hooks' | 'keys';

const TITLES: Record<SettingsSection, string> = {
  general: 'General', collaboration: 'Collaborators', branches: 'Branches', hooks: 'Webhooks', keys: 'Deploy keys',
};

export function SettingsGeneral() {
  return <RepoSettings section="general"/>;
}

export function SettingsCollaboration() {
  return <RepoSettings section="collaboration"/>;
}

export function SettingsBranches() {
  return <RepoSettings section="branches"/>;
}

export function SettingsHooks() {
  return <RepoSettings section="hooks"/>;
}

export function SettingsKeys() {
  return <RepoSettings section="keys"/>;
}

function RepoSettings({section}: {section: SettingsSection}) {
  const {owner, repo, repoId} = useRepoPage();
  const docTitle = section === 'general' ? 'Settings' : `${TITLES[section]} · Settings`;
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={GearIcon} title="Settings" docTitle={docTitle}/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={GearIcon} title="Settings" docTitle={docTitle}/>
      <PageBody><Gate key={repoId} owner={owner} repo={repo} repoId={repoId} section={section}/></PageBody>
    </>
  );
}

/** Administrators get the settings; others the refusal, once their access is known. */
const Gate = observer(function Gate({owner, repo, repoId, section}: {owner: string; repo: string; repoId: number; section: SettingsSection}) {
  const s = useSession();
  if (repoAccess(s, repoId) === 'admin') {
    return <Layout owner={owner} repo={repo} section={section}><Section owner={owner} repo={repo} repoId={repoId} section={section}/></Layout>;
  }
  if (!accessKnown(s, repoId) && connectivity.online) {
    return <Layout owner={owner} repo={repo} section={section}><SettingsSkeleton/></Layout>;
  }
  return (
    <Blankslate><Blankslate.Visual><LockIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Only administrators can change settings</Blankslate.Heading><Blankslate.Description>You do not administer this repository. Its owner and administrators can give you access.</Blankslate.Description>{<RouterLinkButton variant="primary" to="/$owner/$repo" params={{owner, repo}}>Go to the repository</RouterLinkButton>}</Blankslate>
  );
});

function Section({owner, repo, repoId, section}: {owner: string; repo: string; repoId: number; section: SettingsSection}) {
  const props = {owner, repo, repoId};
  switch (section) {
    case 'general':
      return <GeneralSettings {...props}/>;
    case 'collaboration':
      return <CollaboratorSettings {...props}/>;
    case 'branches':
      return <BranchSettings {...props}/>;
    case 'hooks':
      return <HookSettings {...props}/>;
    case 'keys':
      return <KeySettings {...props}/>;
  }
}

/** The sections on the left (a row above on a narrow panel), the section on the right. */
function Layout({owner, repo, section, children}: {owner: string; repo: string; section: SettingsSection; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-4 py-4 @xl:flex-row @xl:gap-8 @xl:px-8 @xl:py-6">
      <SettingsNav owner={owner} repo={repo} section={section}/>
      <div className="flex w-full max-w-xl min-w-0 flex-col gap-8">
        <OfflineNote/>
        {children}
      </div>
    </div>
  );
}

/** The classic UI's settings sections the app does not have (its General page has more options too). */
const CLASSIC_SECTIONS: readonly [string, string][] = [
  ['Units and trackers', 'settings/units'],
  ['Tags', 'settings/tags'],
  ['Actions', 'settings/actions/secrets'],
  ['Git hooks', 'settings/hooks/git'],
  ['LFS', 'settings/lfs'],
  ['More options', 'settings'],
];

function SettingsNav({owner, repo, section}: {owner: string; repo: string; section: SettingsSection}) {
  const app = useApp();
  const params = {owner, repo};
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return (
    <NavList aria-label="Settings" className="shrink-0 @xl:w-64">
      {([
        ['general', '/$owner/$repo/settings', GearIcon],
        ['collaboration', '/$owner/$repo/settings/collaboration', PeopleIcon],
        ['branches', '/$owner/$repo/settings/branches', GitBranchIcon],
        ['hooks', '/$owner/$repo/settings/hooks', WebhookIcon],
        ['keys', '/$owner/$repo/settings/keys', KeyIcon],
      ] as const).map(([id, to, Icon]) => <SettingsNavItem key={id} to={to} params={params} aria-current={id === section ? 'page' : false}>
        <NavList.LeadingVisual><Icon/></NavList.LeadingVisual>{TITLES[id]}
      </SettingsNavItem>)}
      <NavList.Group title="In the classic UI">
        {CLASSIC_SECTIONS.map(([label, path]) => <NavList.Item key={path} href={classicHref(app, `${base}/${path}`)} title={CLASSIC_HINT} data-classic="">
          <NavList.LeadingVisual><BrowserIcon/></NavList.LeadingVisual>{label}
        </NavList.Item>)}
      </NavList.Group>
    </NavList>
  );
}

/** The general section's shape, while the viewer's access is being confirmed. */
function SettingsSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <SkeletonBox className="h-4 w-24"/>
      <div className="flex flex-col gap-2"><SkeletonBox className="h-3 w-32"/><SkeletonBox className="h-control w-full"/></div>
      <div className="flex flex-col gap-2"><SkeletonBox className="h-3 w-24"/><SkeletonText lines={3}/></div>
    </div>
  );
}
