// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {observer} from 'mobx-react-lite';
import type {InboxSearch} from '../../app/search.ts';
import {useSession} from '../../app/store.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {FilterPicker} from './FilterPicker.tsx';
import {SaveViewDialog} from '../views/SaveView.tsx';
import {Button} from '@primer/react';

type Patch = {[K in keyof InboxSearch]?: InboxSearch[K] | undefined};

export const InboxFilters = observer(function InboxFilters({search, set}: {search: InboxSearch; set: (patch: Patch) => void}) {
  const {data} = useSession();
  const [saving, setSaving] = useState(false);
  useShortcut('view.save', () => { setSaving(true); });
  const reasons = [['review-requested', 'Review requested'], ['mentioned', 'Mentioned'], ['assigned', 'Assigned'], ['participating', 'Participating']] as const;
  const types = [['issue', 'Issues'], ['pr', 'Pull requests']] as const;
  const states = [['open', 'Open'], ['closed', 'Closed'], ['merged', 'Merged']] as const;
  const repos = [...data.pool.model('Repository').all()].map((r) => [r.id, r.get('full_name')] as const).sort((a, b) => a[1].localeCompare(b[1]));
  function picker(key: 'reason' | 'repo' | 'type' | 'state', label: string, values: readonly (readonly [string | number, string])[]) {
    return <FilterPicker key={key} label={label} values={values} value={search[key]}
      onChange={(value) => { set({[key]: value} as Patch); }}/>;
  }
  return <>
    {picker('reason', 'Reason', reasons)}
    {picker('repo', 'Repository', repos)}
    {picker('type', 'Type', types)}
    {picker('state', 'State', states)}
    <Button variant="invisible" size="small" type="button" onClick={() => { setSaving(true); }}>Save view…</Button>
    {saving && <SaveViewDialog path="/notifications" search={search} onClose={() => { setSaving(false); }}/>}
  </>;
});
