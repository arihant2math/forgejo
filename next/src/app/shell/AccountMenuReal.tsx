// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Command, Keyboard, LogOut, Monitor, Palette} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactElement} from 'react';
import {
  Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
} from '../../ui/index.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {requestSignOut, switchToClassic} from '../session.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import type {ThemePreference} from '../splash.ts';
import {useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';

/** The account menu (its own chunk: Radix menus are not needed for the first frame). */
export const AccountMenuReal = observer(function AccountMenuReal({trigger, defaultOpen}: {trigger: ReactElement; defaultOpen: boolean}) {
  const app = useApp();
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
        <MenuItem icon={Monitor} disabled={!connectivity.online} onSelect={() => {
          switchToClassic(app);
        }}>{connectivity.online ? 'Switch to the classic UI' : onlineOnly('The classic UI')}</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={LogOut} danger onSelect={() => {
          void requestSignOut(app);
        }}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
});
