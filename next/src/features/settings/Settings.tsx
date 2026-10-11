// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's settings (/{owner}/{repo}/settings[/collaboration|branches|
// hooks|keys], the classic UI's addresses), laid out like GitHub's: the
// sections on the left, the section's forms on the right. Administrators
// only: anyone else gets the refusal (a site administrator, who has no
// Access rows in the pool, waits for API v1's answer instead of seeing it
// flash). The sections the app does not have yet link to the classic UI.
// Writes are online only (PLAN §5.4). Its own chunk.

import {Link} from '@tanstack/react-router';
import {AppWindow, GitBranch, KeyRound, Lock, Settings as SettingsIcon, Users, Webhook} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {accessKnown, repoAccess} from '../../app/access.ts';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {connectivity} from '../../app/online.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {Button, EmptyState, SectionNav, SectionNavHeading, SectionNavLink, Skeleton, SkeletonText} from '../../ui/index.ts';
import {RepoHeader, Unavailable, useRepoPage} from '../repo/repoPage.tsx';
import {OfflineNote} from './bits.tsx';
import {BranchSettings} from './Branches.tsx';
import {CollaboratorSettings} from './Collaborators.tsx';
import {GeneralSettings} from './General.tsx';
import {HookSettings} from './Hooks.tsx';
import {KeySettings} from './Keys.tsx';

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
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={SettingsIcon} title="Settings" docTitle={docTitle}/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={SettingsIcon} title="Settings" docTitle={docTitle}/>
      <PageBody><Gate key={repoId} owner={owner} repo={repo} repoId={repoId} section={section}/></PageBody>
    </>
  );
}

/** Administrators get the settings; others the refusal, once their access is known. */
const Gate = observer(function Gate({owner, repo, repoId, section}: {owner: string; repo: string; repoId: number; section: SettingsSection}) {
  const s = useSession();
  if (repoAccess(s, repoId) === 'admin') {
    return <Layout owner={owner} repo={repo}><Section owner={owner} repo={repo} repoId={repoId} section={section}/></Layout>;
  }
  if (!accessKnown(s, repoId) && connectivity.online) {
    return <Layout owner={owner} repo={repo}><SettingsSkeleton/></Layout>;
  }
  return (
    <EmptyState icon={Lock} title="Only administrators can change settings"
      description="You do not administer this repository. Its owner and administrators can give you access."
      action={<Button asChild variant="primary"><Link to="/$owner/$repo" params={{owner, repo}}>Go to the repository</Link></Button>}/>
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
function Layout({owner, repo, children}: {owner: string; repo: string; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-4 py-4 @xl:flex-row @xl:gap-8 @xl:px-8 @xl:py-6">
      <SettingsNav owner={owner} repo={repo}/>
      <div className="flex w-full max-w-lg min-w-0 flex-col gap-8">
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

function SettingsNav({owner, repo}: {owner: string; repo: string}) {
  const app = useApp();
  const params = {owner, repo};
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return (
    <SectionNav label="Settings">
      <SectionNavLink label="General" icon={SettingsIcon}><Link to="/$owner/$repo/settings" params={params} activeOptions={{exact: true}}/></SectionNavLink>
      <SectionNavLink label="Collaborators" icon={Users}><Link to="/$owner/$repo/settings/collaboration" params={params}/></SectionNavLink>
      <SectionNavLink label="Branches" icon={GitBranch}><Link to="/$owner/$repo/settings/branches" params={params}/></SectionNavLink>
      <SectionNavLink label="Webhooks" icon={Webhook}><Link to="/$owner/$repo/settings/hooks" params={params}/></SectionNavLink>
      <SectionNavLink label="Deploy keys" icon={KeyRound}><Link to="/$owner/$repo/settings/keys" params={params}/></SectionNavLink>
      <SectionNavHeading>In the classic UI</SectionNavHeading>
      {CLASSIC_SECTIONS.map(([label, path]) => (
        <SectionNavLink key={path} label={label} icon={AppWindow} hint="classic">
          <a href={classicHref(app, `${base}/${path}`)} title={CLASSIC_HINT} data-classic=""/>
        </SectionNavLink>
      ))}
    </SectionNav>
  );
}

/** The general section's shape, while the viewer's access is being confirmed. */
function SettingsSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <Skeleton className="h-4 w-24"/>
      <div className="flex flex-col gap-2"><Skeleton className="h-3 w-32"/><Skeleton round="md" className="h-control w-full"/></div>
      <div className="flex flex-col gap-2"><Skeleton className="h-3 w-24"/><SkeletonText lines={3}/></div>
    </div>
  );
}
