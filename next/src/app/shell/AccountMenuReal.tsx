// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useNavigate, useRouter, useRouterState} from '@tanstack/react-router';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useState, type ReactElement} from 'react';
import {ActionMenu, ActionList} from '@primer/react';
import {KeybindingHint} from '@primer/react/experimental';
import {ClassicMenuItem} from '../ClassicMenuItem.tsx';
import {hrefOf} from '../links.ts';
import {connectivity, onlineOnly} from '../online.ts';
import {classicOfHere, switchToClassic} from '../classic.ts';
import {requestSignOut} from '../session.ts';
import {useApp} from '../store.ts';
import {setThemePreference, themeState} from '../theme.ts';
import {BrowserIcon, RepoIcon, OrganizationIcon, CommandPaletteIcon, TelescopeIcon, RepoPullIcon, SignOutIcon, DeviceDesktopIcon, PaintbrushIcon, GearIcon, StarIcon, PersonIcon} from '@primer/octicons-react';

export const AccountMenuReal = observer(function AccountMenuReal({trigger, defaultOpen}: {trigger: ReactElement; defaultOpen: boolean}) {
  const app = useApp();
  const [menuOpen, setMenuOpen] = useState(defaultOpen);
  const navigate = useNavigate();
  const router = useRouter();
  const {path, search} = useRouterState({select: (st) => ({path: st.location.pathname, search: st.location.searchStr}), structuralSharing: true});
  const login = app.session?.data.pool.model('User').get(app.session.userId)?.get('login');
  const theme = themeState.preference;
  const open = (key: 'paletteOpen' | 'shortcutsOpen') => {
    runInAction(() => { app.ui[key] = true; });
  };
  return (
    <ActionMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ActionMenu.Anchor>{trigger}</ActionMenu.Anchor>
      <ActionMenu.Overlay>
        <ActionList>
          {login && <ActionList.Item onSelect={() => void navigate({to: '/$owner', params: {owner: login}})}><ActionList.LeadingVisual><PersonIcon/></ActionList.LeadingVisual>Your profile and repositories</ActionList.Item>}
          {login && <ActionList.Item onSelect={() => void router.navigate({href: hrefOf(app, `/${encodeURIComponent(login)}?tab=stars`)})}><ActionList.LeadingVisual><StarIcon/></ActionList.LeadingVisual>Your stars</ActionList.Item>}
          <ActionList.Item onSelect={() => void navigate({to: '/user/settings'})}><ActionList.LeadingVisual><GearIcon/></ActionList.LeadingVisual>Settings</ActionList.Item>
          <ActionList.Item onSelect={() => void navigate({to: '/repo/create'})}><ActionList.LeadingVisual><RepoIcon/></ActionList.LeadingVisual>New repository</ActionList.Item>
          <ClassicMenuItem to="/repo/migrate" icon={RepoPullIcon}>New migration</ClassicMenuItem>
          <ActionList.Item onSelect={() => void navigate({to: '/org/create'})}><ActionList.LeadingVisual><OrganizationIcon/></ActionList.LeadingVisual>New organization</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Item onSelect={() => { open('paletteOpen'); }}><ActionList.LeadingVisual><CommandPaletteIcon/></ActionList.LeadingVisual>Command menu<ActionList.TrailingVisual><KeybindingHint keys="Mod+k"/></ActionList.TrailingVisual></ActionList.Item>
          <ActionList.Item onSelect={() => { open('shortcutsOpen'); }}><ActionList.LeadingVisual><CommandPaletteIcon/></ActionList.LeadingVisual>Keyboard shortcuts<ActionList.TrailingVisual><KeybindingHint keys="?"/></ActionList.TrailingVisual></ActionList.Item>
          <ActionMenu>
            <ActionMenu.Anchor><ActionList.Item><ActionList.LeadingVisual><PaintbrushIcon/></ActionList.LeadingVisual>Theme</ActionList.Item></ActionMenu.Anchor>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                {(['system', 'light', 'dark'] as const).map((value) => (
                  <ActionList.Item key={value} selected={theme === value} onSelect={() => { setThemePreference(value); }}>{value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark'}</ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          <ActionList.Divider/>
          <ClassicMenuItem to="/explore/repos" icon={TelescopeIcon}>Explore repositories, people and organizations</ClassicMenuItem>
          <ClassicMenuItem to={classicOfHere(app, path, search)} icon={BrowserIcon}>Open this page in the classic UI</ClassicMenuItem>
          <ActionList.Item disabled={!connectivity.online} onSelect={() => { switchToClassic(app); }}><ActionList.LeadingVisual><DeviceDesktopIcon/></ActionList.LeadingVisual>{connectivity.online ? 'Turn off Forgejo Next' : onlineOnly('The classic UI')}</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Item variant="danger" onSelect={() => { void requestSignOut(app); }}><ActionList.LeadingVisual><SignOutIcon/></ActionList.LeadingVisual>Sign out</ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
});
