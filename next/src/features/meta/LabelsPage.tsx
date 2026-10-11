// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's labels (/{owner}/{repo}/labels), as GitHub lays them out:
// each label's pill, description and open issues and pull requests (links
// to the lists filtered by it), an order and a search. Everything comes from
// the pool (counts.ts: the issues on this device), so the page paints at
// once, offline too. Writers create, edit and delete them (online: writes.ts);
// the organization's labels are listed read-only.

import {getRouteApi, Link, useNavigate} from '@tanstack/react-router';
import {Pencil, Tag, Trash2} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {repoAccess} from '../../app/access.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {LabelSort} from '../../app/search.ts';
import {PageBody, PageColumn, viewChange} from '../../app/shell/Frame.tsx';
import {useSession} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {Button, EmptyState, IconButton, LabelPill, ListRow, Panel, PendingIcon, Skeleton, TextLink} from '../../ui/index.ts';
import {exclusiveScope} from '../issues/labels.ts';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import type {LabelCount} from './counts.ts';
import {PageSearch, SortMenu} from './controls.tsx';
import {IssueNav} from './IssueNav.tsx';
import {DeleteLabelDialog, LabelDialog} from './LabelDialog.tsx';
import {filterLabels, LABEL_SORT_NAMES, openCount, sortLabels} from './labels.ts';
import {useRepoCounts} from './repoCounts.ts';
import {isPending, type RepoRef, viewLabels} from './writes.ts';

const labelsApi = getRouteApi('/shell/$owner/$repo/labels');

export function LabelsPage() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={Tag} title="Labels"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <LabelsView key={repoId} r={{owner, repo, repoId}}/>;
}

const LabelsView = observer(function LabelsView({r}: {r: RepoRef}) {
  const {owner, repo, repoId} = r;
  const s = useSession();
  const pool = s.data.pool;
  const search = labelsApi.useSearch();
  const navigate = useNavigate();
  // What is typed filters at once; the URL follows when typing pauses.
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const q = typed ?? search.q ?? '';
  const sort: LabelSort = search.sort ?? 'alphabetically';
  const write = useCanWrite(repoId);
  const counts = useRepoCounts(repoId).get().labels;
  const [editing, setEditing] = useState<{label?: Label} | undefined>(undefined);
  const [deleting, setDeleting] = useState<Label | undefined>(undefined);
  const own = viewLabels([...pool.model('Label').by('repo_id', repoId)].map((e) => e.data), repoId);
  const repoEntity = pool.model('Repository').get(repoId);
  const ownerId = repoEntity?.get('owner_id');
  const orgName = repoEntity?.get('owner_name') ?? owner;
  const org = ownerId === undefined ? [] : [...pool.model('Label').by('org_id', ownerId)].map((e) => e.data).filter((l) => l.repo_id === 0);
  const shown = (ls: Label[]) => sortLabels(filterLabels(ls, q), sort, counts);
  const active = shown(own.filter((l) => !l.archived_at));
  const archived = shown(own.filter((l) => l.archived_at));
  const orgActive = shown(org.filter((l) => !l.archived_at));
  const go = (next: {q?: string | undefined; sort?: LabelSort | undefined}) => {
    const merged = {...search, ...next};
    void navigate({to: '.', replace: true, ...viewChange(), search: {...(merged.q ? {q: merged.q} : {}), ...(merged.sort && merged.sort !== 'alphabetically' ? {sort: merged.sort} : {})} as never});
  };
  const offline = !connectivity.online;
  const loading = s.data.status.loading > 0 && own.length === 0 && org.length === 0;
  const create = write && (
    <Button size="sm" variant="primary" icon={Tag} disabled={offline} tooltip={offline ? onlineOnly('Creating a label') : undefined} onClick={() => {
      setEditing({});
    }}>New label</Button>
  );
  const rows = (ls: Label[], editable: boolean) => ls.map((l) => (
    <LabelRow key={l.id} r={r} label={l} count={counts.get(l.id)} editable={editable && write}
      onEdit={() => {
        setEditing({label: l});
      }} onDelete={() => {
        setDeleting(l);
      }}/>
  ));
  const filtered = q.trim() !== '';
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={Tag} title="Labels">
        <IssueNav owner={owner} repo={repo} repoId={repoId} current="labels"/>
        <PageSearch label="Search labels" value={search.q ?? ''} onChange={setTyped} onSettle={(text) => {
          setTyped(undefined);
          go({q: text.trim() || undefined});
        }}/>
        <SortMenu value={sort} names={LABEL_SORT_NAMES} onChange={(v) => {
          go({sort: v});
        }}/>
        {create}
      </RepoHeader>
      <PageBody>
        <PageColumn wide>
          <Panel label="Labels" title={<span className="tabular-nums">{loading ? 'Labels' : `${String(active.length)} ${active.length === 1 ? 'label' : 'labels'}`}</span>}>
            {loading ? <LabelsSkeleton/> : rows(active, true)}
            {!loading && active.length === 0 && (filtered ?
              <EmptyState title="No label matches" description="No label of this repository has these words in its name or description."/> :
              <EmptyState icon={Tag} title="No labels yet" description="Labels sort issues and pull requests: a kind, an area, a status." action={create}/>)}
          </Panel>
          {orgActive.length > 0 && (
            <Panel label={`Labels of ${orgName}`} title={<span>Labels of the organization {orgName}</span>}
              actions={repoAccess(s, repoId) === 'admin' && <ClassicLink size="sm" to={`/org/${encodeURIComponent(orgName)}/settings/labels`}>Manage</ClassicLink>}>
              <p className="border-b border-border-subtle px-3 py-2 text-sm text-fg-muted">
                Every repository of {orgName} can use these. They are managed in the organization’s settings.
              </p>
              {rows(orgActive, false)}
            </Panel>
          )}
          {archived.length > 0 && (
            <Panel label="Archived labels" title={<span className="tabular-nums">{`${String(archived.length)} archived`}</span>}>
              <p className="border-b border-border-subtle px-3 py-2 text-sm text-fg-muted">They stay on their issues but are no longer offered in the pickers.</p>
              {rows(archived, true)}
            </Panel>
          )}
        </PageColumn>
      </PageBody>
      {editing && <LabelDialog repo={r} label={editing.label} count={own.length} onClose={() => {
        setEditing(undefined);
      }}/>}
      {deleting && <DeleteLabelDialog repo={r} label={deleting} open={openCount(counts.get(deleting.id))} onClose={() => {
        setDeleting(undefined);
      }}/>}
    </>
  );
});

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** One label: its pill and description; its open issues and pull requests (the lists filtered by it); edit and delete. */
const LabelRow = observer(function LabelRow({r, label, count, editable, onEdit, onDelete}: {
  r: RepoRef; label: Label; count: LabelCount | undefined; editable: boolean; onEdit: () => void; onDelete: () => void;
}) {
  const {owner, repo} = r;
  const pending = isPending('Label', label.id);
  const offline = !connectivity.online;
  const scope = exclusiveScope(label);
  const issues = count?.issues ?? 0;
  const pulls = count?.pulls ?? 0;
  const ids = {labels: String(label.id)};
  return (
    <ListRow role={undefined} trailing={<>
      {pending && <PendingIcon label="Saving to Forgejo"/>}
      {label.id > 0 && (
        <span className="flex w-40 justify-end gap-3 tabular-nums max-md:hidden">
          {pulls > 0 && <TextLink><Link to="/$owner/$repo/pulls" params={{owner, repo}} search={ids}>{plural(pulls, 'pull request', 'pull requests')}</Link></TextLink>}
          <TextLink><Link to="/$owner/$repo/issues" params={{owner, repo}} search={ids}>{issues ? plural(issues, 'open issue', 'open issues') : 'No open issues'}</Link></TextLink>
        </span>
      )}
      {editable && (
        <span className="flex">
          <IconButton size="sm" icon={Pencil} label={offline ? onlineOnly('Editing a label') : `Edit ${label.name}`} disabled={offline || label.id < 0} onClick={onEdit}/>
          <IconButton size="sm" icon={Trash2} label={offline ? onlineOnly('Deleting a label') : `Delete ${label.name}`} disabled={offline || label.id < 0} onClick={onDelete}/>
        </span>
      )}
    </>}>
      <LabelPill name={label.name} color={label.color} scope={scope || undefined}/>
      {label.description && <span className="ml-3 text-fg-subtle">{label.description}</span>}
    </ListRow>
  );
});

const widths = ['w-16', 'w-24', 'w-20', 'w-28', 'w-12'];

/** The rows' shape while the repository's labels load for the first time. */
function LabelsSkeleton() {
  return <>{widths.map((w) => <ListRow key={w} role="presentation" trailing={<Skeleton className="h-3 w-20"/>}><Skeleton round="full" className={`h-5 ${w}`}/></ListRow>)}</>;
}
