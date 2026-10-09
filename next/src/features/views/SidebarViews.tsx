// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar's saved views (its own chunk, loaded when the app is idle: the
// boot route does not carry it; it sits below the workspace, so arriving
// moves nothing above it).

import {Link} from '@tanstack/react-router';
import {Layers, Pencil, Trash2} from 'lucide-react';
import {useState} from 'react';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, NavHeading, NavItem, PromptDialog} from '../../ui/index.ts';
import {type SavedView, viewStore} from './views.ts';

export const SidebarViews = observer(function SidebarViews() {
  const {userId} = useSession();
  const store = viewStore(userId);
  if (!store.views.length) return null;
  return (
    <>
      <NavHeading>Views</NavHeading>
      {store.views.map((v) => <ViewItem key={v.id} view={v} onOpen={() => {
        store.open(v.id);
      }} onRemove={() => {
        store.remove(v.id);
      }} onRename={(name) => {
        store.rename(v.id, name);
      }}/>)}
    </>
  );
});

/**
 * A saved view (kept on this device: the tooltip says so); right click renames or removes it, as does the view's
 * menu in the list's header once it is open.
 */
function ViewItem({view, onOpen, onRemove, onRename}: {view: SavedView; onOpen: () => void; onRemove: () => void; onRename: (name: string) => void}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <NavItem asChild icon={Layers} label={view.name}>
            <Link to={view.path} search={view.search as never} activeOptions={{includeSearch: true, exact: true}} data-view={view.id} onClick={onOpen}
              title={`${view.name} (a view saved on this device)`}/>
          </NavItem>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon={Pencil} onSelect={() => {
            setRenaming(true);
          }}>Rename the view…</ContextMenuItem>
          <ContextMenuItem icon={Trash2} danger onSelect={onRemove}>Remove the view</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {renaming && <PromptDialog title="Rename the view" label="View name" initial={view.name} maxLength={80} onClose={() => {
        setRenaming(false);
      }} onSave={onRename}/>}
    </>
  );
}
