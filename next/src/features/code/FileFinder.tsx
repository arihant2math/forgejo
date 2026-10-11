// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// GitHub's "Go to file" (and its key, T): a field under the button that
// finds any file of the ref on screen by fuzzy match (code/fuzzy.ts) and
// opens it in the code view. The paths are the commit's recursive tree from
// the code cache (CodeSource.paths, the same list ⌘K's files read): asked
// for when the pointer or the focus reaches the button, so it is usually
// there when the field opens; kept forever by commit SHA. Matching is local:
// each keystroke rescans only the previous one's matches, and never holds
// up the field (a deferred value). The highlighted result is fetched ahead.

import {useNavigate} from '@tanstack/react-router';
import {File, Search} from 'lucide-react';
import {useDeferredValue, useEffect, useMemo, useState} from 'react';
import {codeSplat, type Resolved} from '../../code/refs.ts';
import {FileSearcher, markRuns} from '../../code/fuzzy.ts';
import {CodeSource, type PathList} from '../../code/source.ts';
import {shortcutHint, useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {Button, CommandEmpty, CommandInput, CommandItem, CommandList, CommandRoot, Popover, PopoverContent, PopoverTrigger, Skeleton} from '../../ui/index.ts';
import {useLoad, useSource} from './hooks.ts';
import {codeTo} from './nav.tsx';
import {Unloaded} from './states.tsx';

/** Files listed at most (type more to narrow). */
const LIMIT = 50;
/** A highlighted result is prefetched once it stays highlighted this long (ms): not every row the arrows pass. */
const PREFETCH_DELAY = 120;

interface FinderProps {
  owner: string;
  repo: string;
  repoId: number;
  at: Pick<Resolved, 'kind' | 'ref' | 'sha'>;
}

/** The "Go to file" button and its finder; T opens it on the pages that show it (repository code pages). */
export function GoToFile(props: FinderProps) {
  const src = useSource();
  const [open, setOpen] = useState(false);
  useShortcutScope('code');
  useShortcut('code.findFile', () => {
    setOpen(true);
  });
  // Intent: the list is on its way before the click.
  const prefetch = () => {
    void src.paths(props.repoId, props.at.sha).catch(() => undefined);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" icon={Search} tooltip="Find a file in this branch" shortcut={shortcutHint('code.findFile')} onPointerEnter={prefetch} onFocus={prefetch}>
          Go to file
        </Button>
      </PopoverTrigger>
      <PopoverContent width="lg" align="end">
        {open && <Finder {...props} onClose={() => {
          setOpen(false);
        }}/>}
      </PopoverContent>
    </Popover>
  );
}

function Finder({owner, repo, repoId, at, onClose}: FinderProps & {onClose: () => void}) {
  const src = useSource();
  const navigate = useNavigate();
  const key = CodeSource.pathsKey(repoId, at.sha);
  const list = useLoad(key, () => src.peek<PathList>(key), () => src.paths(repoId, at.sha));
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  // Each search narrows the previous keystroke's matches.
  const [searcher] = useState(() => new FileSearcher());
  const paths = list.state === 'ready' ? list.value.paths : undefined;
  const hits = useMemo(() => (paths ? searcher.find(paths, deferred, LIMIT) : []), [searcher, paths, deferred]);
  // The first match is selected whenever the matches change (Enter opens it); the arrow keys move it.
  const first = hits[0]?.path ?? '';
  const [sel, setSel] = useState({first: '', value: ''});
  let selected = sel.value;
  if (sel.first !== first) {
    selected = first;
    setSel({first, value: first});
  }
  // The highlighted file (under the pointer, or reached with the arrows), once it stays a moment: fetched and
  // highlighted at idle priority, like a tree row on intent, so that opening it paints at once.
  useEffect(() => {
    if (!selected) return undefined;
    const timer = setTimeout(() => {
      void src.entry(repoId, at.sha, selected).then((e) => {
        if (e?.type !== 'blob') return null;
        return src.blob(repoId, e.sha, selected, e.size).then((c) => (c.kind === 'text' ? src.highlight(repoId, e.sha, selected, c.text, 'idle') : null));
      }).catch(() => undefined);
    }, PREFETCH_DELAY);
    return () => {
      clearTimeout(timer);
    };
  }, [src, repoId, at.sha, selected]);
  const open = (path: string) => {
    onClose();
    void navigate(codeTo(owner, repo, codeSplat('src', {kind: at.kind, ref: at.kind === 'commit' ? at.sha : at.ref}, path)));
  };
  return (
    <CommandRoot label="Files" value={selected} onValueChange={(v) => {
      setSel({first, value: v});
    }}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Go to file…"/>
      <CommandList>
        {list.state !== 'ready' ? (
          <Unloaded loaded={list} what="This branch's files" skeleton={
            <div className="flex flex-col gap-2 p-2" aria-busy><Skeleton className="h-3 w-48"/><Skeleton className="h-3 w-64"/><Skeleton className="h-3 w-40"/></div>
          }/>
        ) : (
          <>
            {!hits.length && <CommandEmpty>{list.value.paths.length ? 'No file matches.' : 'No files here.'}</CommandEmpty>}
            {hits.map((h) => (
              <CommandItem key={h.path} value={h.path} icon={File} onSelect={() => {
                open(h.path);
              }}>
                {markRuns(h.path, h.marks).map((r, i) => (r.marked ? <span key={i} className="font-semibold text-accent-fg">{r.text}</span> : r.text))}
              </CommandItem>
            ))}
            {list.value.truncated && <p className="px-2 py-1.5 text-sm text-fg-subtle">This tree is too large to list every file.</p>}
          </>
        )}
      </CommandList>
    </CommandRoot>
  );
}
