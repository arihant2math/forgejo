// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {observer} from 'mobx-react-lite';
import type {InboxSearch} from '../../app/search.ts';
import {useSession} from '../../app/store.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {Button, CommandPopover, type PickOption} from '../../ui/index.ts';
import {SaveViewDialog} from '../views/SaveView.tsx';

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
    const options: PickOption[] = [{value: 'all', label: `All ${label.toLowerCase()}`, onSelect: () => { set({[key]: undefined}); }}, ...values.map(([value, text]) => ({value: String(value), label: text, onSelect: () => { set({[key]: value} as Patch); }}))];
    const current = values.find(([value]) => value === search[key])?.[1];
    return <CommandPopover key={key} label={label} placeholder={`Filter by ${label.toLowerCase()}…`} options={options} trigger={<Button size="sm" variant="ghost" pressed={search[key] !== undefined}>{current ? `${label}: ${current}` : label}</Button>}/>;
  }
  return <>
    {picker('reason', 'Reason', reasons)}
    {picker('repo', 'Repository', repos)}
    {picker('type', 'Type', types)}
    {picker('state', 'State', states)}
    <Button size="sm" variant="ghost" onClick={() => { setSaving(true); }}>Save view…</Button>
    {saving && <SaveViewDialog path="/notifications" search={search} onClose={() => { setSaving(false); }}/>}
  </>;
});
