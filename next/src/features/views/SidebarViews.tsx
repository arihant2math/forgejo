// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar's saved views (its own chunk, loaded when the app is idle: the
// boot route does not carry it; it sits below the workspace, so arriving
// moves nothing above it).

import {Link, useRouterState} from '@tanstack/react-router';
import {useRef, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {ActionList, ActionMenu, NavList} from '@primer/react';
import {ViewNameDialog} from './ViewNameDialog.tsx';
import {type SavedView, viewStore} from './views.ts';
import {StackIcon, PencilIcon, TrashIcon} from '@primer/octicons-react';

export const SidebarViews = observer(function SidebarViews() {
  const {userId} = useSession();
  const store = viewStore(userId);
  if (!store.views.length) return null;
  return (
    <NavList aria-label="Saved views">
      <NavList.Group title="Views">
      {store.views.map((v) => <ViewItem key={v.id} view={v} onOpen={() => {
        store.open(v.id);
      }} onRemove={() => {
        store.remove(v.id);
      }} onRename={(name) => {
        store.rename(v.id, name);
      }}/>)}</NavList.Group>
    </NavList>
  );
});

/**
 * A saved view (kept on this device: the tooltip says so); right click renames or removes it, as does the view's
 * menu in the list's header once it is open.
 */
function ViewItem({view, onOpen, onRemove, onRename}: {view: SavedView; onOpen: () => void; onRemove: () => void; onRename: (name: string) => void}) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const location = useRouterState({select: (state) => state.location});
  const current = location.pathname === view.path && Object.keys(location.search).length === Object.keys(view.search).length && Object.entries(view.search).every(([key, value]) => location.search[key as keyof typeof location.search] === value);
  return (
    <>
      <NavList.Item as={Link} ref={anchorRef} to={view.path} search={view.search as never}
        aria-current={current ? 'page' : false} data-view={view.id} onClick={onOpen}
        title={`${view.name} (a view saved on this device)`}
        onContextMenu={(event) => {event.preventDefault(); setMenuOpen(true);}}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}>
        <NavList.LeadingVisual><StackIcon/></NavList.LeadingVisual>{view.name}
      </NavList.Item>
      <ActionMenu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={anchorRef}>
        <ActionMenu.Overlay><ActionList>
          <ActionList.Item onSelect={() => {setRenaming(true);}}>
            <ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>Rename the view…
          </ActionList.Item>
          <ActionList.Item variant="danger" onSelect={onRemove}>
            <ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Remove the view
          </ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {renaming && <ViewNameDialog title="Rename the view" initial={view.name}
        onClose={() => {setRenaming(false);}} onSave={onRename}/>}
    </>
  );
}
