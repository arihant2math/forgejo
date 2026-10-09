// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar's saved views (its own chunk, loaded when the app is idle: the
// boot route does not carry it; it sits below the workspace, so arriving
// moves nothing above it).

import {Link} from '@tanstack/react-router';
import {Layers, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, NavHeading, NavItem} from '../../ui/index.ts';
import {type SavedView, viewStore} from './views.ts';

export const SidebarViews = observer(function SidebarViews() {
  const {userId} = useSession();
  const store = viewStore(userId);
  if (!store.views.length) return null;
  return (
    <>
      <NavHeading>Views</NavHeading>
      {store.views.map((v) => <ViewItem key={v.id} view={v} onRemove={() => {
        store.remove(v.id);
      }}/>)}
    </>
  );
});

function ViewItem({view, onRemove}: {view: SavedView; onRemove: () => void}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <NavItem asChild icon={Layers} label={view.name}>
          <Link to={view.path} search={view.search as never} activeOptions={{includeSearch: true, exact: true}}/>
        </NavItem>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={Trash2} danger onSelect={onRemove}>Remove the view</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
