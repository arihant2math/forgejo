// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Separate from the source view so the overview can use ref pickers without loading it.

import {useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {codeSplat, type RefKind, type RefTable, type Resolved, shortSha} from '../../code/refs.ts';
import {ChoicePanel, type CodeChoice} from './ChoicePanel.tsx';
import {usePool} from '../issues/cells.tsx';
import {refTable} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {looksLikeSha, type RefChoice} from './refWrite.ts';
import {ChevronDownIcon, GitBranchIcon, GitCommitIcon, TagIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';

function refOptions(refs: RefTable, current: string, onSelect: (kind: RefKind, ref: string) => void, branchesOnly = false): CodeChoice[] {
  const branches = [...refs.branches.keys()].sort((a, b) => (a === refs.defaultBranch ? -1 : b === refs.defaultBranch ? 1 : a.localeCompare(b)));
  const tags = branchesOnly ? [] : [...refs.tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const option = (kind: RefKind, ref: string): CodeChoice => ({
    value: `${kind}:${ref}`, label: ref, group: kind === 'branch' ? 'Branches' : 'Tags', icon: kind === 'branch' ? GitBranchIcon : TagIcon,
    meta: kind === 'branch' && ref === refs.defaultBranch ? 'default' : undefined, checked: current === `${kind}:${ref}`,
    onSelect: () => {
      onSelect(kind, ref);
    },
  });
  return [...branches.map((b) => option('branch', b)), ...tags.map((t) => option('tag', t))];
}

const kindIcon = (kind: RefKind) => (kind === 'tag' ? TagIcon : kind === 'commit' ? GitCommitIcon : GitBranchIcon);

export const RefMenu = observer(function RefMenu({owner, repo, repoId, at, view}: {
  owner: string; repo: string; repoId: number; at: Pick<Resolved, 'kind' | 'ref' | 'sha' | 'path'>; view: 'src' | 'blame' | 'commits';
}) {
  const pool = usePool();
  const navigate = useNavigate();
  const options = refOptions(refTable(pool, repoId), `${at.kind}:${at.ref}`, (kind, ref) => {
    void navigate(codeTo(owner, repo, codeSplat(view, {kind, ref}, at.path)));
  });
  const label = at.kind === 'commit' ? shortSha(at.sha) : at.ref;
  return (
    <ChoicePanel title="Switch branch or tag" placeholder="Find a branch or tag…" empty="No branch or tag is on this device."
      choices={options}
      anchor={
        <Button size="small" leadingVisual={kindIcon(at.kind)} trailingVisual={ChevronDownIcon} type="button" aria-label={`Ref: ${label}`}>
          <span className="block max-w-xs truncate">{label}</span>
        </Button>
      }/>
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
  }, branchesOnly);
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
