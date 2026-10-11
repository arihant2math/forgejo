// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useNavigate, useRouterState} from '@tanstack/react-router';
import {AppWindow, BookPlus, Building2, Command, Import, Keyboard, LogOut, Monitor, Palette, Settings, User} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactElement} from 'react';
import {
  Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
} from '../../ui/index.ts';
import {ClassicMenuItem} from '../ClassicMenuItem.tsx';
import {connectivity, onlineOnly} from '../online.ts';
import {classicOfHere, requestSignOut, switchToClassic} from '../session.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import type {ThemePreference} from '../splash.ts';
import {useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';

/** The account menu (its own chunk: Radix menus are not needed for the first frame). */
export const AccountMenuReal = observer(function AccountMenuReal({trigger, defaultOpen}: {trigger: ReactElement; defaultOpen: boolean}) {
  const app = useApp();
  const navigate = useNavigate();
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
        {login && <MenuItem icon={User} onSelect={() => void navigate({to: '/$owner', params: {owner: login}})}>Your profile and repositories</MenuItem>}
        <MenuItem icon={Settings} onSelect={() => void navigate({to: '/user/settings'})}>Settings</MenuItem>
        <MenuItem icon={BookPlus} onSelect={() => void navigate({to: '/repo/create'})}>New repository</MenuItem>
        <ClassicMenuItem to="/repo/migrate" icon={Import}>New migration</ClassicMenuItem>
        <MenuItem icon={Building2} onSelect={() => void navigate({to: '/org/create'})}>New organization</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={Command} shortcut={shortcutHint('palette.open')} onSelect={() => {
          open('paletteOpen');
        }}>Command menu</MenuItem>
        <MenuItem icon={Keyboard} shortcut={shortcutHint('help.shortcuts')} onSelect={() => {
          open('shortcutsOpen');
        }}>Keyboard shortcuts</MenuItem>
        <MenuSub label="Theme" icon={Palette}>
          <MenuRadioGroup value={theme} onValueChange={(v) => {
            setThemePreference(v as ThemePreference);
          }}>
            <MenuRadioItem value="system">System</MenuRadioItem>
            <MenuRadioItem value="light">Light</MenuRadioItem>
            <MenuRadioItem value="dark">Dark</MenuRadioItem>
          </MenuRadioGroup>
        </MenuSub>
        <MenuSeparator/>
        <ClassicMenuItem to={classicOfHere(app, path, search)} icon={AppWindow}>This page</ClassicMenuItem>
        <MenuItem icon={Monitor} disabled={!connectivity.online} onSelect={() => {
          switchToClassic(app);
        }}>{connectivity.online ? 'Turn off Forgejo Next' : onlineOnly('The classic UI')}</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={LogOut} danger onSelect={() => {
          void requestSignOut(app);
        }}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
});
