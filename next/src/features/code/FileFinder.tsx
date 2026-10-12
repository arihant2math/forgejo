// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Defer fuzzy matching and prefetch highlighted files at idle priority.
import {useNavigate} from '@tanstack/react-router';
import {useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {Button, SelectPanel, Tooltip, type SelectPanelItemInput} from '@primer/react';
import {FileIcon, SearchIcon} from '@primer/octicons-react';
import {SkeletonBox} from '@primer/react/experimental';
import {codeSplat, type Resolved} from '../../code/refs.ts';
import {FileSearcher} from '../../code/fuzzy.ts';
import {CodeSource, type PathList} from '../../code/source.ts';
import {shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {enterPicksFirst} from '../../components/pickOptions.ts';
import {useLoad, useSource, warmFile} from './hooks.ts';
import {useApp} from '../../app/store.ts';
import {codeTo} from './nav.tsx';
import {Unloaded} from './states.tsx';

const LIMIT = 50;
const PREFETCH_DELAY = 120;
interface FinderProps {
  owner: string; repo: string; repoId: number; at: Pick<Resolved, 'kind' | 'ref' | 'sha'>;
}

export function GoToFile(props: FinderProps) {
  const src = useSource();
  const [open, setOpen] = useState(false);
  useShortcutScope('code');
  useShortcut('code.findFile', () => { setOpen(true); });
  const prefetch = () => { void src.paths(props.repoId, props.at.sha).catch(() => undefined); };
  return <Finder {...props} open={open} setOpen={setOpen} prefetch={prefetch}/>;
}

function Finder({owner, repo, repoId, at, open, setOpen, prefetch}: FinderProps & {
  open: boolean; setOpen: (open: boolean) => void; prefetch: () => void;
}) {
  const src = useSource();
  const {config: {base}} = useApp();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const key = CodeSource.pathsKey(repoId, at.sha);
  // Fetch on intent/open, not just because the toolbar mounted.
  const list = useLoad(open ? key : undefined, () => src.peek<PathList>(key), () => src.paths(repoId, at.sha));
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [searcher] = useState(() => new FileSearcher());
  const paths = list.state === 'ready' ? list.value.paths : undefined;
  const hits = useMemo(() => paths ? searcher.find(paths, deferred, LIMIT) : [], [searcher, paths, deferred]);
  const [selected, setSelected] = useState('');
  const first = hits[0]?.path ?? '';
  const intent = hits.some((hit) => hit.path === selected) ? selected : first;
  useEffect(() => {
    if (!open || !intent) return;
    const timer = setTimeout(() => {
      void src.entry(repoId, at.sha, intent).then((entry) => {
        if (entry?.type === 'blob') warmFile(src, base, repoId, entry.sha, intent, entry.size);
      }).catch(() => undefined);
    }, PREFETCH_DELAY);
    return () => { clearTimeout(timer); };
  }, [src, base, repoId, at.sha, intent, open]);
  const choosePath = (path: string) => {
    setOpen(false); setQuery('');
    void navigate(codeTo(owner, repo, codeSplat('src', {kind: at.kind, ref: at.kind === 'commit' ? at.sha : at.ref}, path)));
  };
  const items = hits.map((hit) => ({id: hit.path, text: hit.path, leadingVisual: FileIcon, 'data-path': hit.path}));
  return <SelectPanel title="Go to file" aria-label="Files" inputLabel="Go to file…" placeholderText="Go to file…"
    open={open} anchorRef={anchorRef} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}
    filterValue={query} onFilterChange={setQuery} items={items} selected={undefined} loading={false} setInitialFocus focusPrependedElements width="large" align="end"
    onSelectedChange={(item: SelectPanelItemInput | undefined) => {
      if (typeof item?.id !== 'string') return;
      choosePath(item.id);
    }}
    textInputProps={{onKeyDown: enterPicksFirst}}
    onActiveDescendantChanged={(element) => { const path = element?.getAttribute('data-path'); if (path) setSelected(path); }}
    {...(hits.length ? {} : {message: list.state === 'ready' ? {title: paths?.length ? 'No file matches.' : 'No files here.', body: '', variant: 'empty' as const} : {
      title: list.state === 'loading' ? 'Loading files' : 'Files unavailable', variant: 'empty' as const,
      body: <Unloaded loaded={list} what="This branch's files" skeleton={<div className="flex flex-col gap-2 p-2" aria-busy><SkeletonBox className="h-3 w-48"/><SkeletonBox className="h-3 w-64"/></div>}/>,
    }})}
    {...(list.state === 'ready' && list.value.truncated ? {notice: {text: 'This tree is too large to list every file.', variant: 'warning' as const}} : {})}
    renderAnchor={(anchorProps) => <Tooltip text="Find a file in this branch" keybindingHint={shortcutHint('code.findFile')}><Button {...anchorProps} size="small" leadingVisual={SearchIcon} onPointerEnter={prefetch} onFocus={prefetch}>Go to file</Button></Tooltip>}/>;
}
