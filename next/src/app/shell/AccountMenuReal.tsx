// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Command, Keyboard, LogOut, Monitor, Palette} from 'lucide-react';
import {runInAction} from 'mobx';
import {type ReactElement, useState} from 'react';
import {
  Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger,
} from '../../ui/index.ts';
import {sitePath, uiPath} from '../config.ts';
import {requestSignOut} from '../session.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import type {ThemePreference} from '../splash.ts';
import {useApp} from '../store.ts';
import {getThemePreference, setThemePreference} from '../theme.ts';

/** The account menu (its own chunk: Radix menus are not needed for the first frame). */
export function AccountMenuReal({trigger, defaultOpen}: {trigger: ReactElement; defaultOpen: boolean}) {
  const app = useApp();
  const [theme, setTheme] = useState(getThemePreference);
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
            setTheme(v as ThemePreference);
          }}>
            <MenuRadioItem value="system">System</MenuRadioItem>
            <MenuRadioItem value="light">Light</MenuRadioItem>
            <MenuRadioItem value="dark">Dark</MenuRadioItem>
          </MenuRadioGroup>
        </MenuSub>
        <MenuItem icon={Monitor} onSelect={() => {
          // Turns the opt-in cookie off and opens this page in the classic UI (the
          // UI's own pages have no classic counterpart: the dashboard then).
          const here = `${location.pathname}${location.search}`;
          const back = location.pathname.startsWith(app.config.base) ? sitePath(app.config, '/') : here;
          location.assign(`${uiPath(app.config, 'opt-out')}?redirect=${encodeURIComponent(back)}`);
        }}>Switch to the classic UI</MenuItem>
        <MenuSeparator/>
        <MenuItem icon={LogOut} danger onSelect={() => {
          void requestSignOut(app);
        }}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}
