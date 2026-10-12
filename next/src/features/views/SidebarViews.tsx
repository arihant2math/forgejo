// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Load below the workspace on idle to keep boot small without moving existing content.

import {Link, useRouterState} from '@tanstack/react-router';
import {useRef, useState} from 'react';
import {observer} from 'mobx-react-lite';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import {ActionList, ActionMenu, NavList} from '@primer/react';
import {ViewNameDialog} from './ViewNameDialog.tsx';
import {type SavedView, viewStore} from './views.ts';
import {StackIcon, PencilIcon, TrashIcon, KebabHorizontalIcon} from '@primer/octicons-react';

export const SidebarViews = observer(function SidebarViews() {
  const app = useApp();
  const {userId} = useSession();
  const store = viewStore(userId);
  const location = useRouterState({select: (state) => state.location});
  if (!store.views.length) return null;
  const current = store.match(location.pathname, location.search as SavedView['search'])?.id;
  return (
    <NavList aria-label="Saved views">
      <NavList.Group title="Views">
      {store.views.map((v) => <ViewItem key={v.id} view={v} current={v.id === current} onOpen={() => {
        store.open(v.id);
      }} onRemove={() => {
        store.remove(v.id);
        notify(app, {tone: 'neutral', title: `Deleted the view “${v.name}”`, action: {label: 'Undo', run: () => {
          store.save(v.name, v.path, v.search);
        }}});
      }} onRename={(name) => {
        store.rename(v.id, name);
      }}/>)}</NavList.Group>
    </NavList>
  );
});

function ViewItem({view, current, onOpen, onRemove, onRename}: {view: SavedView; current: boolean; onOpen: () => void; onRemove: () => void; onRename: (name: string) => void}) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <NavList.Item as={Link} to={view.path} search={view.search as never}
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
        <NavList.TrailingAction ref={anchorRef} icon={KebabHorizontalIcon} label={`Options for the view ${view.name}`} onClick={() => { setMenuOpen(true); }}/>
      </NavList.Item>
      <ActionMenu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={anchorRef}>
        <ActionMenu.Overlay><ActionList>
          <ActionList.Item onSelect={() => {setRenaming(true);}}>
            <ActionList.LeadingVisual><PencilIcon/></ActionList.LeadingVisual>Rename…
          </ActionList.Item>
          <ActionList.Item variant="danger" onSelect={onRemove}>
            <ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>Delete view
          </ActionList.Item>
        </ActionList></ActionMenu.Overlay>
      </ActionMenu>
      {renaming && <ViewNameDialog title="Rename the view" initial={view.name}
        onClose={() => {setRenaming(false);}} onSave={onRename}/>}
    </>
  );
}
