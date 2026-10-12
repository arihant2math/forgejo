// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {Link, getRouteApi, useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {OrganizationLabels} from './OrganizationLabels.tsx';
import {connectivity, onlineOnly} from '../../app/online.ts';
import type {LabelSort} from '../../app/search.ts';
import {PageBody, PageColumn, viewChange} from '../../app/shell/Frame.tsx';
import {useSession} from '../../app/store.ts';
import type {Label} from '../../protocol/types.gen.ts';
import {MetadataSection, LabelListRow, SavingIndicator} from './LabelList.tsx';
import {RepoHeader, Unavailable, useCanWrite, useRepoPage} from '../repo/repoPage.tsx';
import type {LabelCount} from './counts.ts';
import {SortMenu} from './controls.tsx';
import {SearchField} from '../issues/SearchField.tsx';
import {useShortcutScope} from '../../app/shortcuts/index.ts';
import {IssueNav} from './IssueNav.tsx';
import {DeleteLabelDialog, LabelDialog} from './LabelDialog.tsx';
import {filterLabels, LABEL_SORT_NAMES, openCount, sortLabels} from './labels.ts';
import {useRepoCounts} from './repoCounts.ts';
import {isPending, type RepoRef, viewLabels} from './writes.ts';
import {PencilIcon, TagIcon, TrashIcon} from '@primer/octicons-react';
import {IssueLabelToken, Button, IconButton} from '@primer/react';
import {Tooltip} from '@primer/react';
import {SkeletonBox} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

const labelsApi = getRouteApi('/shell/$owner/$repo/labels');

export function LabelsPage() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={TagIcon} title="Labels"/>
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
  // The search field's shortcut lives in the list scope.
  useShortcutScope('list');
  const navigate = useNavigate();
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
  const isOrg = ownerId !== undefined && pool.model('User').get(ownerId)?.get('type') === 'organization';
  const go = (next: {q?: string | undefined; sort?: LabelSort | undefined}) => {
    const merged = {...search, ...next};
    void navigate({to: '.', replace: true, ...viewChange(), search: {...(merged.q ? {q: merged.q} : {}), ...(merged.sort && merged.sort !== 'alphabetically' ? {sort: merged.sort} : {})} as never});
  };
  const offline = !connectivity.online;
  const loading = s.data.status.loading > 0 && own.length === 0 && org.length === 0;
  const create = write && (
    <Tooltip text={offline ? onlineOnly('Creating a label') : 'Create a label'}><Button variant="primary" size="small" type="button" inactive={offline} onClick={() => {
      setEditing({});
    }}>New label</Button></Tooltip>
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
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={TagIcon} title="Labels">
        <IssueNav owner={owner} repo={repo} repoId={repoId} current="labels"/>
        <SearchField label="Search labels" value={search.q ?? ''} onChange={setTyped} onSettle={(text) => {
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
          <MetadataSection label="Labels" title={<span className="tabular-nums">{loading ? 'Labels' : `${String(active.length)} ${active.length === 1 ? 'label' : 'labels'}`}</span>}>
            {loading ? <LabelsSkeleton/> : rows(active, true)}
            {!loading && active.length === 0 && (filtered ?
              <EmptyState title="No label matches" description="No label of this repository has these words in its name or description."/> :
              <EmptyState icon={TagIcon} title="No labels yet" description="Labels sort issues and pull requests: a kind, an area, a status." action={create}/>)}
          </MetadataSection>
          {(isOrg || org.length > 0) && <OrganizationLabels owner={orgName} usage={(l) => <LabelUsage r={r} label={l} count={counts.get(l.id)}/>}/>}
          {archived.length > 0 && (
            <MetadataSection label="Archived labels" title={<span className="tabular-nums">{`${String(archived.length)} archived`}</span>}>
              <p className="border-b border-muted px-4 py-2 text-sm text-muted">They stay on their issues but are no longer offered in the pickers.</p>
              {rows(archived, true)}
            </MetadataSection>
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

const LabelRow = observer(function LabelRow({r, label, count, editable, onEdit, onDelete}: {
  r: RepoRef; label: Label; count: LabelCount | undefined; editable: boolean; onEdit: () => void; onDelete: () => void;
}) {
  const pending = isPending('Label', label.id);
  const offline = !connectivity.online;
  return (
    <LabelListRow role={undefined} trailing={<>
      {pending && <SavingIndicator label="Saving to Forgejo"/>}
      <LabelUsage r={r} label={label} count={count}/>
      {editable && (
        <span className="flex">
          <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label={offline ? onlineOnly('Editing a label') : `Edit ${label.name}`} type="button" inactive={offline || label.id < 0} onClick={onEdit}/>
          <IconButton icon={TrashIcon} variant="invisible" size="small" aria-label={offline ? onlineOnly('Deleting a label') : `Delete ${label.name}`} type="button" inactive={offline || label.id < 0} onClick={onDelete}/>
        </span>
      )}
    </>}>
      <IssueLabelToken text={label.name} fillColor={label.color}/>
      {label.description && <span className="text-base text-muted">{label.description}</span>}
    </LabelListRow>
  );
});

function LabelUsage({r, label, count}: {r: RepoRef; label: Pick<Label, 'id'>; count: LabelCount | undefined}) {
  const {owner, repo} = r;
  if (label.id <= 0) return null;
  const issues = count?.issues ?? 0;
  const pulls = count?.pulls ?? 0;
  const ids = {labels: String(label.id)};
  return (
    <span className="flex w-40 justify-end gap-4 text-base tabular-nums max-md:hidden">
      {pulls > 0 && <Link to="/$owner/$repo/pulls" params={{owner, repo}} search={ids} className="min-w-0 truncate text-default hover:text-accent hover:underline">{plural(pulls, 'pull request', 'pull requests')}</Link>}
      <Link to="/$owner/$repo/issues" params={{owner, repo}} search={ids} className="min-w-0 truncate text-default hover:text-accent hover:underline">{issues ? plural(issues, 'open issue', 'open issues') : 'No open issues'}</Link>
    </span>
  );
}

const widths = ['w-16', 'w-24', 'w-20', 'w-28', 'w-12'];

function LabelsSkeleton() {
  return <>{widths.map((w) => <LabelListRow key={w} role="presentation" trailing={<SkeletonBox className="h-3 w-20"/>}><SkeletonBox className={`h-5 ${w}`}/></LabelListRow>)}</>;
}
