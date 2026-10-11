// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The account menu loads on intent, not on the boot route.
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {Avatar, Button} from '@primer/react';
import {SkeletonAvatar} from '@primer/react/experimental';
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
  const preload = () => { void Real.preload().catch(() => undefined); };
  const visual = () => avatar ? <Avatar size={20} alt="" src={avatar}/> : <SkeletonAvatar size={20}/>;
  const trigger = <Button variant="invisible" className="w-full" leadingVisual={visual} aria-haspopup="menu">{login}</Button>;
  if (wanted) return <Real trigger={trigger} defaultOpen/>;
  return (
    <Button variant="invisible" className="w-full" leadingVisual={visual} aria-haspopup="menu" onPointerEnter={preload} onFocus={preload} onClick={() => {
      void Real.preload().then(() => { setWanted(true); }, (err: unknown) => { console.error('loading the account menu failed', err); });
    }}>{login}</Button>
  );
});
