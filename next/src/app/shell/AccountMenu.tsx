// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The account row at the top of the sidebar. Its menu (Radix) loads on
// intent — hover, focus — or on the first click, which then opens it.

import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {Avatar, NavItem} from '../../ui/index.ts';
import {lazyComponent} from '../lazy.tsx';
import {useApp, useSession} from '../store.ts';

const Real = lazyComponent(() => import('./AccountMenuReal.tsx').then((m) => m.AccountMenuReal));

export const AccountMenu = observer(function AccountMenu() {
  const app = useApp();
  const {data, userId} = useSession();
  const me = data.pool.model('User').get(userId);
  const login = me?.get('login') ?? app.config.app_name;
  const avatar = me?.get('avatar_url');
  const [wanted, setWanted] = useState(false);
  const preload = () => {
    void Real.preload().catch(() => undefined);
  };
  const trigger = <NavItem label={login} leading={<Avatar size="sm" name={login} src={avatar}/>} aria-haspopup="menu"/>;
  if (wanted) return <Real trigger={trigger} defaultOpen/>;
  return (
    <NavItem
      label={login}
      leading={<Avatar size="sm" name={login} src={avatar}/>}
      aria-haspopup="menu"
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => {
        // Swapped for the real menu (opened) once its chunk is here: never a blank row.
        void Real.preload().then(() => {
          setWanted(true);
        }, (err: unknown) => {
          console.error('loading the account menu failed', err);
        });
      }}
    />
  );
});
