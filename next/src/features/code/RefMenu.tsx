// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The branch or tag picker of the code views and of the repository's
// overview (above its files, like GitHub's): its own module, so the overview
// does not pull in the source view to show it. Refs come from the pool.
// RefPicker is the same list as a form's field (a new branch's source, a new
// tag's target), which may also take a commit typed by its SHA.

import {useNavigate} from '@tanstack/react-router';
import {ChevronDown, GitBranch, GitCommitHorizontal, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';
import {codeSplat, type RefKind, type RefTable, type Resolved, shortSha} from '../../code/refs.ts';
import {Button, CommandPick, CommandPopover, Icon, type PickOption} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {refTable} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {looksLikeSha, type RefChoice} from './refWrite.ts';

/** A repository's branches (the default one first) and tags (newest version first) as picker options. */
function refOptions(refs: RefTable, current: string, onSelect: (kind: RefKind, ref: string) => void, branchesOnly = false): PickOption[] {
  const branches = [...refs.branches.keys()].sort((a, b) => (a === refs.defaultBranch ? -1 : b === refs.defaultBranch ? 1 : a.localeCompare(b)));
  const tags = branchesOnly ? [] : [...refs.tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const option = (kind: RefKind, ref: string): PickOption => ({
    value: `${kind}:${ref}`, label: ref, group: kind === 'branch' ? 'Branches' : 'Tags', icon: kind === 'branch' ? GitBranch : Tag,
    meta: kind === 'branch' && ref === refs.defaultBranch ? 'default' : undefined, checked: current === `${kind}:${ref}`,
    onSelect: () => {
      onSelect(kind, ref);
    },
  });
  return [...branches.map((b) => option('branch', b)), ...tags.map((t) => option('tag', t))];
}

const kindIcon = (kind: RefKind) => (kind === 'tag' ? Tag : kind === 'commit' ? GitCommitHorizontal : GitBranch);

/**
 * The branch or tag on screen, and every other one to switch to (same path, same view): a picker that filters
 * as you type (Enter takes the first match), branches first.
 */
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
    <CommandPopover width="md" label="Switch branch or tag" placeholder="Find a branch or tag…" empty="No branch or tag is on this device."
      options={options}
      trigger={
        <Button size="sm" icon={kindIcon(at.kind)} aria-label={`Ref: ${label}`}>
          <span className="max-w-xs truncate font-mono">{label}</span><Icon icon={ChevronDown} size="sm"/>
        </Button>
      }/>
  );
});

/**
 * A form's ref field: the repository's branches and tags (or its branches only), and — with `commits` — a commit
 * typed by its SHA (seven hex digits at least: Forgejo resolves it).
 */
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
    options.unshift({value: `commit:${typed}`, label: typed, group: 'Commit', icon: GitCommitHorizontal, checked: value.kind === 'commit' && value.ref === typed, onSelect: () => {
      onChange({kind: 'commit', ref: typed});
    }});
  }
  const what = branchesOnly ? 'a branch' : commits ? 'a branch, tag or commit SHA' : 'a branch or tag';
  const shown = value.kind === 'commit' ? shortSha(value.ref) : value.ref;
  return (
    <CommandPopover width="md" label={label} placeholder={`Find ${what}…`} options={options}
      onOpenChange={(o) => {
        if (!o) setQuery('');
      }}
      render={(close) => (
        <CommandPick label={label} placeholder={`Find ${what}…`} options={options} onClose={close} query={query} onQueryChange={setQuery}
          empty={commits ? 'No branch or tag of that name. A commit: its SHA, seven characters at least.' : 'No branch or tag of that name is on this device.'}/>
      )}
      trigger={
        <Button size="sm" icon={kindIcon(value.kind)} aria-label={`${label}: ${shown || 'none'}`}>
          <span className="max-w-xs truncate font-mono">{shown || 'Choose…'}</span><Icon icon={ChevronDown} size="sm"/>
        </Button>
      }/>
  );
});
