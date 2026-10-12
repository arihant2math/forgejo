// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Separate from the source view so the overview can use ref pickers without loading it.

import {useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {lazy, Suspense, useState} from 'react';
import {codeSplat, type RefKind, type Resolved, shortSha} from '../../code/refs.ts';
import {ChoicePanel, type CodeChoice} from './ChoicePanel.tsx';
import {usePool} from '../issues/cells.tsx';
import {type RefIndex, refTable} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {looksLikeSha, type RefChoice} from './refWrite.ts';
import {ChevronDownIcon, GitBranchIcon, GitCommitIcon, TagIcon} from '@primer/octicons-react';
import {Button, SegmentedControl, SelectPanel} from '@primer/react';
import {canWrite} from '../../app/access.ts';
import {sitePath} from '../../app/config.ts';
import {plainClick} from '../../app/links.ts';
import {codePath} from '../../app/paths.ts';
import {useApp, useSession} from '../../app/store.ts';

/** `grouped` heads the branches and the tags; otherwise one kind is listed. */
function refOptions(refs: RefIndex, current: string, onSelect: (kind: RefKind, ref: string) => void, kinds: 'grouped' | 'branches' | 'tags'): CodeChoice[] {
  const branches = kinds === 'tags' ? [] : refs.branchNames;
  const tags = kinds === 'branches' ? [] : refs.tagNames;
  const option = (kind: RefKind, ref: string): CodeChoice => ({
    value: `${kind}:${ref}`, label: ref, ...(kinds === 'grouped' ? {group: kind === 'branch' ? 'Branches' : 'Tags'} : {}), icon: kind === 'branch' ? GitBranchIcon : TagIcon,
    meta: kind === 'branch' && ref === refs.defaultBranch ? 'default' : undefined, checked: current === `${kind}:${ref}`,
    onSelect: () => {
      onSelect(kind, ref);
    },
  });
  return [...branches.map((b) => option('branch', b)), ...tags.map((t) => option('tag', t))];
}

const kindIcon = (kind: RefKind) => (kind === 'tag' ? TagIcon : kind === 'commit' ? GitCommitIcon : GitBranchIcon);

const NewBranchDialog = lazy(() => import('./RefDialogs.tsx').then((m) => ({default: m.NewBranchDialog})));

/** GitHub's branch/tag picker: Branches | Tags, View all, and (for writers) creating the typed branch from the current ref. */
export const RefMenu = observer(function RefMenu({owner, repo, repoId, at, view}: {
  owner: string; repo: string; repoId: number; at: Pick<Resolved, 'kind' | 'ref' | 'sha' | 'path'>; view: 'src' | 'blame' | 'commits';
}) {
  const app = useApp();
  const pool = usePool();
  const navigate = useNavigate();
  const writer = canWrite(useSession(), repoId);
  const [tab, setTab] = useState<'branches' | 'tags'>(at.kind === 'tag' ? 'tags' : 'branches');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<string>();
  const refs = refTable(pool, repoId);
  const go = (kind: RefKind, ref: string) => {
    void navigate(codeTo(owner, repo, codeSplat(view, {kind, ref}, at.path)));
  };
  const options = refOptions(refs, `${at.kind}:${at.ref}`, go, tab);
  const label = at.kind === 'commit' ? shortSha(at.sha) : at.ref;
  const typed = query.trim();
  if (tab === 'branches' && writer && typed && !refs.branches.has(typed)) {
    options.push({value: `create:${typed}`, label: `Create branch: ${typed} from ${label}`, words: typed, icon: GitBranchIcon, onSelect: () => { setCreating(typed); }});
  }
  const page = tab === 'branches' ? 'branches' : 'tags';
  const viewAll = codeTo(owner, repo, page);
  return (
    <>
      <ChoicePanel title="Switch branches/tags" placeholder={tab === 'tags' ? 'Find a tag…' : writer ? 'Find or create a branch…' : 'Find a branch…'}
        empty="Nothing to show" choices={options} query={query} onQueryChange={setQuery}
        subtitle={
          <SegmentedControl size="small" fullWidth aria-label="Show" onChange={(i) => { setTab(i === 1 ? 'tags' : 'branches'); }}>
            <SegmentedControl.Button selected={tab === 'branches'}>Branches</SegmentedControl.Button>
            <SegmentedControl.Button selected={tab === 'tags'}>Tags</SegmentedControl.Button>
          </SegmentedControl>
        }
        footer={
          <SelectPanel.SecondaryActionLink href={sitePath(app.config, codePath(owner, repo, page))} onClick={(e) => {
            if (!plainClick(e)) return;
            e.preventDefault();
            void navigate(viewAll);
          }}>{`View all ${page}`}</SelectPanel.SecondaryActionLink>
        }
        anchor={
          <Button size="small" leadingVisual={kindIcon(at.kind)} trailingVisual={ChevronDownIcon} type="button" aria-label={`Ref: ${label}`}>
            <span className="block max-w-xs truncate">{label}</span>
          </Button>
        }/>
      {creating !== undefined && <Suspense fallback={null}>
        <NewBranchDialog repoId={repoId} name={creating} from={{kind: at.kind, ref: at.kind === 'commit' ? at.sha : at.ref}}
          onClose={() => { setCreating(undefined); }} onCreated={(name) => { go('branch', name); }}/>
      </Suspense>}
    </>
  );
});

/** With commits enabled, accept SHA abbreviations of at least seven hex digits for server resolution. */
export const RefPicker = observer(function RefPicker({repoId, label, value, onChange, branchesOnly = false, commits = false}: {
  repoId: number; label: string; value: RefChoice; onChange: (choice: RefChoice) => void; branchesOnly?: boolean; commits?: boolean;
}) {
  const pool = usePool();
  const [query, setQuery] = useState('');
  const options = refOptions(refTable(pool, repoId), `${value.kind}:${value.ref}`, (kind, ref) => {
    onChange({kind, ref});
  }, branchesOnly ? 'branches' : 'grouped');
  const typed = query.trim().toLowerCase();
  if (commits && looksLikeSha(typed)) {
    options.unshift({value: `commit:${typed}`, label: typed, group: 'Commit', icon: GitCommitIcon, checked: value.kind === 'commit' && value.ref === typed, onSelect: () => {
      onChange({kind: 'commit', ref: typed});
    }});
  }
  const what = branchesOnly ? 'a branch' : commits ? 'a branch, tag or commit SHA' : 'a branch or tag';
  const shown = value.kind === 'commit' ? shortSha(value.ref) : value.ref;
  return (
    <ChoicePanel title={label} placeholder={`Find ${what}…`} choices={options} query={query} onQueryChange={setQuery}
      onOpenChange={(o) => {
        if (!o) setQuery('');
      }}

      anchor={
        <Button size="small" leadingVisual={kindIcon(value.kind)} trailingVisual={ChevronDownIcon} type="button" aria-label={`${label}: ${shown || 'none'}`}>
          <span className="block max-w-xs truncate">{shown || 'Choose…'}</span>
        </Button>
      }/>
  );
});
