// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useNavigate, useRouter, useRouterState} from '@tanstack/react-router';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactElement} from 'react';
import {
  Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
} from '../../ui/index.ts';
import {ClassicMenuItem} from '../ClassicMenuItem.tsx';
import {hrefOf} from '../links.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {classicOfHere, requestSignOut, switchToClassic} from '../session.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import type {ThemePreference} from '../splash.ts';
import {useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';
import {BrowserIcon, RepoIcon, OrganizationIcon, CommandPaletteIcon, TelescopeIcon, RepoPullIcon, SignOutIcon, DeviceDesktopIcon, PaintbrushIcon, GearIcon, StarIcon, PersonIcon} from '@primer/octicons-react';

/** The account menu (its own chunk: Radix menus are not needed for the first frame). */
export const AccountMenuReal = observer(function AccountMenuReal({trigger, defaultOpen}: {trigger: ReactElement; defaultOpen: boolean}) {
  const app = useApp();
  const navigate = useNavigate();
  const router = useRouter();
  const {path, search} = useRouterState({select: (st) => ({path: st.location.pathname, search: st.location.searchStr}), structuralSharing: true});
  const login = app.session?.data.pool.model('User').get(app.session.userId)?.get('login');
  const theme = themeState.preference;
  const open = (key: 'paletteOpen' | 'shortcutsOpen') => {
    runInAction(() => {
      app.ui[key] = true;
    });
  };
  return (
    <Menu defaultOpen={defaultOpen}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent>
        {login && <MenuItem icon={PersonIcon} onSelect={() => void navigate({to: '/$owner', params: {owner: login}})}>Your profile and repositories</MenuItem>}
        {/* The profile's Stars tab, at its own address (features/owner/OwnerPage.tsx). */}
        {login && <MenuItem icon={StarIcon} onSelect={() => void router.navigate({href: hrefOf(app, `/${encodeURIComponent(login)}?tab=stars`)})}>Your stars</MenuItem>}
        <MenuItem icon={GearIcon} onSelect={() => void navigate({to: '/user/settings'})}>Settings</MenuItem>
        <MenuItem icon={RepoIcon} onSelect={() => void navigate({to: '/repo/create'})}>New repository</MenuItem>
        <ClassicMenuItem to="/repo/migrate" icon={RepoPullIcon}>New migration</ClassicMenuItem>
        <MenuItem icon={OrganizationIcon} onSelect={() => void navigate({to: '/org/create'})}>New organization</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={CommandPaletteIcon} shortcut={shortcutHint('palette.open')} onSelect={() => {
          open('paletteOpen');
        }}>Command menu</MenuItem>
        <MenuItem icon={CommandPaletteIcon} shortcut={shortcutHint('help.shortcuts')} onSelect={() => {
          open('shortcutsOpen');
        }}>Keyboard shortcuts</MenuItem>
        <MenuSub label="Theme" icon={PaintbrushIcon}>
          <MenuRadioGroup value={theme} onValueChange={(v) => {
            setThemePreference(v as ThemePreference);
          }}>
            <MenuRadioItem value="system">System</MenuRadioItem>
            <MenuRadioItem value="light">Light</MenuRadioItem>
            <MenuRadioItem value="dark">Dark</MenuRadioItem>
          </MenuRadioGroup>
        </MenuSub>
        <MenuSeparator/>
        <ClassicMenuItem to="/explore/repos" icon={TelescopeIcon}>Explore repositories, people and organizations</ClassicMenuItem>
        <ClassicMenuItem to={classicOfHere(app, path, search)} icon={BrowserIcon}>Open this page in the classic UI</ClassicMenuItem>
        <MenuItem icon={DeviceDesktopIcon} disabled={!connectivity.online} onSelect={() => {
          switchToClassic(app);
        }}>{connectivity.online ? 'Turn off Forgejo Next' : onlineOnly('The classic UI')}</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={SignOutIcon} danger onSelect={() => {
          void requestSignOut(app);
        }}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
});
