// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// "Save view" (Shift+V on a list, its Display menu): names the list as it
// is — page, filters, grouping, ordering — and puts it in the sidebar's
// Views and the palette.

import {useState} from 'react';
import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Button, Dialog, Input} from '../../ui/index.ts';
import {type SavedView, viewStore} from './views.ts';

export function SaveViewDialog({path, search, onClose}: {path: string; search: SavedView['search']; onClose: () => void}) {
  const app = useApp();
  const {userId} = useSession();
  const [name, setName] = useState('');
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const v = viewStore(userId).save(n, path, search);
    onClose();
    if (v) notify(app, {tone: 'neutral', title: `Saved the view “${v.name}”`, description: 'It is in the sidebar and the command menu.'});
  };
  return (
    <Dialog open size="sm" title="Save the view" description="This list with its filters, grouping and ordering." onOpenChange={(o) => {
      if (!o) onClose();
    }} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!name.trim()} onClick={save}>Save</Button>
    </>}>
      <Input aria-label="View name" placeholder="Name" value={name} autoFocus className="w-full" maxLength={80} onChange={(e) => {
        setName(e.target.value);
      }} onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
        }
      }}/>
    </Dialog>
  );
}
