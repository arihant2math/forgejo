// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// "Save view" (Shift+V on a list, its Display menu): names the list as it
// is — page, filters, grouping, ordering — and puts it in the sidebar's
// Views and the palette.

import {notify} from '../../app/notices.ts';
import {useApp, useSession} from '../../app/store.ts';
import {PromptDialog} from '../../ui/index.ts';
import {type SavedView, viewStore} from './views.ts';

export function SaveViewDialog({path, search, onClose}: {path: string; search: SavedView['search']; onClose: () => void}) {
  const app = useApp();
  const {userId} = useSession();
  return (
    <PromptDialog title="Save the view" description="This list with its filters, grouping and ordering, kept on this device." label="View name" maxLength={80}
      onClose={onClose} onSave={(name) => {
        const v = viewStore(userId).save(name, path, search);
        if (!v) return;
        notify(app, {tone: 'neutral', title: `Saved the view “${v.name}” on this device`, description: 'It is under Views in the sidebar, and in the command menu.'});
        // The new entry comes into view in the sidebar (it may be below its fold).
        requestAnimationFrame(() => {
          document.querySelector(`[data-view="${v.id}"]`)?.scrollIntoView({block: 'nearest'});
        });
      }}/>
  );
}
