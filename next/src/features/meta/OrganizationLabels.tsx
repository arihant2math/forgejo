// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Pencil, Tag, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Button, Dialog, IconButton, LabelPill, ListRow, Panel} from '../../ui/index.ts';
import {useOrgPermissions} from '../owner/Teams.tsx';
import {ResourceList, useOffline} from '../settings/bits.tsx';
import {allPages} from '../settings/requests.ts';
import {useResource} from '../settings/resource.ts';
import {LabelDialog} from './LabelDialog.tsx';
import {type LabelDraft, normalizeColor} from './labels.ts';

export const OrganizationLabels = observer(function OrganizationLabels({owner}: {owner: string}) {
  const app = useApp();
  const offline = useOffline();
  const {data} = useSession();
  const org = [...data.pool.model('User').by('login', owner)][0];
  const pooled = org ? [...data.pool.model('Label').by('org_id', org.id)].map((l) => l.data) : [];
  const perms = useOrgPermissions(owner);
  const editable = perms.fresh && (perms.value?.is_owner === true || perms.value?.is_admin === true);
  const base = `/orgs/${encodeURIComponent(owner)}/labels`;
  const res = useResource(`org:${owner}:labels`, async (signal) => {
    const labels = await allPages<Pick<Label, 'id' | 'name' | 'description' | 'color' | 'exclusive'> & {is_archived: boolean}>(app, base, signal);
    return labels.map((l): Label => ({...l, repo_id: 0, org_id: 0, num_issues: 0, num_closed_issues: 0, created_at: '', ...(l.is_archived ? {archived_at: 'archived'} : {})}));
  });
  const shown = res.value === undefined && pooled.length > 0 ? {...res, value: pooled, state: 'ready' as const} : res;
  const [editing, setEditing] = useState<{label?: Label}>();
  const [deleting, setDeleting] = useState<Label>();
  const [busy, setBusy] = useState(false);
  const send = async (method: 'POST' | 'PATCH' | 'DELETE', label?: Label, draft?: LabelDraft): Promise<boolean> => {
    setBusy(true);
    try {
      await online(app, {api: 'v1', method, path: label ? `${base}/${String(label.id)}` : base,
        ...(draft ? {body: {name: draft.name.trim(), description: draft.description, color: normalizeColor(draft.color), exclusive: draft.exclusive, is_archived: draft.archived}} : {})});
      res.reload();
      return true;
    } catch (err) {
      notify(app, {tone: 'danger', title: 'Organization label was not changed', description: failureText(err)});
      return false;
    } finally { setBusy(false); }
  };
  return <Panel label={`Labels of ${owner}`} title={`Organization labels · ${owner}`} actions={editable && <Button size="sm" disabled={offline || busy} tooltip={offline ? onlineOnly('Creating an organization label') : undefined} onClick={() => { setEditing({}); }}>New organization label</Button>}>
    <ResourceList res={shown} what="The organization labels" empty={{icon: Tag, title: 'No organization labels', description: 'These labels are available to every repository in the organization.'}}>
      {(labels) => labels.map((l) => <ListRow key={l.id} role={undefined} trailing={editable && <>
        <IconButton icon={Pencil} label={offline ? onlineOnly('Editing an organization label') : `Edit organization label ${l.name}`} disabled={offline || busy} onClick={() => { setEditing({label: l}); }}/>
        <IconButton icon={Trash2} label={offline ? onlineOnly('Deleting an organization label') : `Delete organization label ${l.name}`} disabled={offline || busy} onClick={() => { setDeleting(l); }}/>
      </>}><LabelPill name={l.name} color={l.color}/><span className="ml-3 text-fg-muted">{l.description}{l.archived_at ? ' · Archived' : ''}</span></ListRow>)}
    </ResourceList>
    {editing && <LabelDialog repo={{owner, repo: '', repoId: 0}} label={editing.label} count={shown.value?.length ?? 0} onClose={() => { setEditing(undefined); }} onSave={(d) => send(editing.label ? 'PATCH' : 'POST', editing.label, d)}/>}
    {deleting && <Dialog open title={`Delete the label “${deleting.name}”?`} description="This removes the label from every issue and pull request in the organization. This cannot be undone." onOpenChange={(o) => { if (!o) setDeleting(undefined); }} footer={<>
      <Button variant="ghost" onClick={() => { setDeleting(undefined); }}>Cancel</Button>
      <Button variant="danger" disabled={busy || offline} onClick={() => { void send('DELETE', deleting).then((ok) => { if (ok) setDeleting(undefined); }); }}>Delete label</Button>
    </>}/>}
  </Panel>;
});
