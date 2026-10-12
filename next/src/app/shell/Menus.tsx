// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The triggers render at boot; the menus load on first hover, focus or click.

import {observer} from 'mobx-react-lite';
import {type ReactElement, useState} from 'react';
import {Avatar, Button, IconButton, Text} from '@primer/react';
import {SkeletonAvatar} from '@primer/react/experimental';
import {PlusIcon} from '@primer/octicons-react';
import {type LazyComponent, lazyComponent} from '../lazy.tsx';
import {useApp, useSession} from '../store.ts';

interface MenuProps {
  trigger: ReactElement;
  defaultOpen: boolean;
}

interface TriggerProps {
  onPointerEnter?: () => void;
  onFocus?: () => void;
  onClick?: () => void;
}

const AccountMenuReal = lazyComponent(() => import('./MenusReal.tsx').then((m) => m.AccountMenuReal));
const CreateMenuReal = lazyComponent(() => import('./MenusReal.tsx').then((m) => m.CreateMenuReal));

/** One trigger element before and after loading, so the swap cannot shift the layout. */
function LazyMenu({menu: Menu, trigger}: {menu: LazyComponent<MenuProps>; trigger: (props: TriggerProps) => ReactElement}) {
  const [wanted, setWanted] = useState(false);
  if (wanted) return <Menu trigger={trigger({})} defaultOpen/>;
  const preload = () => { void Menu.preload().catch(() => undefined); };
  return trigger({onPointerEnter: preload, onFocus: preload, onClick: () => {
    void Menu.preload().then(() => { setWanted(true); }, (err: unknown) => { console.error('loading a menu failed', err); });
  }});
}

export const AccountMenu = observer(function AccountMenu() {
  const app = useApp();
  const {data, userId} = useSession();
  const me = data.pool.model('User').get(userId);
  const login = me?.get('login') ?? app.config.app_name;
  const avatar = me?.get('avatar_url');
  // A fixed layout slot keeps an image from collapsing in Button’s min-content grid.
  const visual = () => <span className="flex h-5 w-6 shrink-0 items-center">{avatar ? <Avatar size={20} alt="" src={avatar}/> : <SkeletonAvatar size={20}/>}</span>;
  return <LazyMenu menu={AccountMenuReal} trigger={(handlers) => (
    <Button variant="invisible" size="small" alignContent="start" className="w-full" leadingVisual={visual} aria-haspopup="menu"
      onPointerEnter={handlers.onPointerEnter} onFocus={handlers.onFocus} onClick={handlers.onClick}>
      <Text size="medium" weight="semibold">{login}</Text>
    </Button>
  )}/>;
});

export function CreateMenu() {
  return <LazyMenu menu={CreateMenuReal} trigger={(handlers) => (
    <IconButton icon={PlusIcon} variant="invisible" size="small" aria-label="Create new…" aria-haspopup="menu" type="button"
      onPointerEnter={handlers.onPointerEnter} onFocus={handlers.onFocus} onClick={handlers.onClick}/>
  )}/>;
}
