// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {labelFill} from '../issues/labels.ts';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {onlineOnly} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {MetadataSection, LabelListRow} from './LabelList.tsx';
import {useOrgPermissions} from '../owner/Teams.tsx';
import {ResourceList, useOffline} from '../settings/bits.tsx';
import {allPages} from '../settings/requests.ts';
import {useResource} from '../settings/resource.ts';
import {LabelDialog} from './LabelDialog.tsx';
import {type LabelDraft, normalizeColor} from './labels.ts';
import {PencilIcon, TagIcon, TrashIcon} from '@primer/octicons-react';
import {IssueLabelToken, Button, IconButton, Dialog} from '@primer/react';
import {Tooltip} from '@primer/react';

/** usage renders repository-specific counts and links for organization labels. */
export const OrganizationLabels = observer(function OrganizationLabels({owner, usage}: {owner: string; usage?: ((label: Label) => ReactNode) | undefined}) {
  const app = useApp();
  const offline = useOffline();
  const {data} = useSession();
  const org = [...data.pool.model('User').by('login', owner)][0];
  const pooled = org ? [...data.pool.model('Label').by('org_id', org.id)].map((l) => l.data) : [];
  const perms = useOrgPermissions(owner);
  const editable = perms.fresh && (perms.value?.is_owner === true || perms.value?.is_admin === true);
  const managed = !editable && !(perms.state === 'loading' && perms.value === undefined);
  const base = `/orgs/${encodeURIComponent(owner)}/labels`;
  const res = useResource(`org:${owner}:labels`, async (signal) => {
    const labels = await allPages<Pick<Label, 'id' | 'name' | 'description' | 'color' | 'exclusive'> & {is_archived: boolean}>(app, base, signal);
    // API v1 omits the colour's # prefix; pills require #rrggbb.
    return labels.map((l): Label => ({...l, color: normalizeColor(l.color) ?? l.color, repo_id: 0, org_id: 0, num_issues: 0, num_closed_issues: 0, created_at: '', ...(l.is_archived ? {archived_at: 'archived'} : {})}));
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
  return <MetadataSection label={`Labels of ${owner}`} title={`Organization labels · ${owner}`} actions={editable && <Tooltip text={offline ? onlineOnly('Creating an organization label') : 'Create an organization label'}><Button size="small" type="button" inactive={offline || busy} onClick={() => { setEditing({}); }}>New organization label</Button></Tooltip>}>
    {managed && <p className="border-b border-muted px-4 py-2 text-sm text-muted">
      Managed by the owners and admins of {owner}: only they can change these labels. Every repository of the organization can use them.
    </p>}
    <ResourceList res={shown} what="The organization labels" empty={{icon: TagIcon, title: 'No organization labels', description: 'These labels are available to every repository in the organization.'}}>
      {(labels) => labels.map((l) => <LabelListRow key={l.id} role={undefined} trailing={<>
        {usage?.(l)}
        {editable && <span className="flex">
          <IconButton icon={PencilIcon} variant="invisible" aria-label={offline ? onlineOnly('Editing an organization label') : `Edit organization label ${l.name}`} type="button" inactive={offline || busy} onClick={() => { setEditing({label: l}); }}/>
          <IconButton icon={TrashIcon} variant="invisible" aria-label={offline ? onlineOnly('Deleting an organization label') : `Delete organization label ${l.name}`} type="button" inactive={offline || busy} onClick={() => { setDeleting(l); }}/>
        </span>}
      </>}><IssueLabelToken text={l.name} fillColor={labelFill(l.color)}/><span className="text-base text-muted">{l.description}{l.archived_at ? ' · Archived' : ''}</span></LabelListRow>)}
    </ResourceList>
    {editing && <LabelDialog repo={{owner, name: '', id: 0}} label={editing.label} count={shown.value?.length ?? 0} onClose={() => { setEditing(undefined); }} onSave={(d) => send(editing.label ? 'PATCH' : 'POST', editing.label, d)}/>}
    {deleting && <Dialog title={`Delete the label “${deleting.name}”?`} subtitle="This removes the label from every issue and pull request in the organization. This cannot be undone." width="large" onClose={() => { setDeleting(undefined); }} footerButtons={[
      {content: 'Cancel', onClick: () => { setDeleting(undefined); }},
      {content: 'Delete label', buttonType: 'danger', disabled: busy || offline, onClick: () => { void send('DELETE', deleting).then((ok) => { if (ok) setDeleting(undefined); }); }},
    ]}></Dialog>}
  </MetadataSection>;
});
