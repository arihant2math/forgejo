// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A diff, virtualized per row (PLAN §5.7): one list for every file of a
// commit, a compare or a pull request (code/rows.ts). Code rows have one
// fixed height; only thread rows (comments, drafts, a composer) are
// measured. Highlighting is per file, asked of the worker when a file's rows
// come near the view, and each row is memoized on its own data — a file's
// highlighting arriving re-renders that file's rows only, a scroll frame
// mounts the rows coming into view. A floating header names the file in
// view; `[` and `]` jump between files.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {ChevronDown, ChevronRight, MessageSquarePlus} from 'lucide-react';
import {memo, type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {ADD, DEL, type DiffFile, filePath} from '../../code/diff.ts';
import {diffRows, fileAt, type Row} from '../../code/rows.ts';
import type {Highlight} from '../../code/source.ts';
import {CodeFileHeader, CodeLine, CodeTokens, DiffStat, EmptyState, IconButton, LineAction, LineNo} from '../../ui/index.ts';
import {useSource} from './hooks.ts';
import {LINE, useScrollMargin} from './Lines.tsx';

/** A file header row: the header (h-row, 32) after an 8 px gap. */
const FILE_ROW = 40;
const EMPTY_ROW = 40;

/** What a pull request adds to its diff: threads, notes, the comment button, per-file actions, collapsing. */
export interface DiffExtras {
  threads: ReadonlySet<string>;
  notes: ReadonlySet<number>;
  collapsed: ReadonlySet<number>;
  thread: (f: number, l: number) => ReactNode;
  notesOf: (f: number) => ReactNode;
  /** Starts a comment on line l of file f (undefined: no comments here, e.g. offline without the head). */
  onComment?: ((f: number, l: number) => void) | undefined;
  fileActions: (f: number) => ReactNode;
  onToggle: (f: number) => void;
}

export interface DiffHandle {
  /** Scrolls to a file's header. */
  toFile(f: number): void;
  /** Scrolls a line into view. */
  toLine(f: number, l: number): void;
  /** The file in view. */
  current(): number;
}

interface DiffViewProps {
  repoId: number;
  base: string;
  head: string;
  files: readonly DiffFile[];
  scroller: HTMLDivElement | null;
  extras?: DiffExtras | undefined;
  /** The file in view changed (the file list follows). */
  onFile?: ((f: number) => void) | undefined;
  ref?: Ref<DiffHandle>;
}

const STATUS: Record<DiffFile['status'], string | undefined> = {added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'copied', modified: undefined};

/** Per-file highlighting, asked of the worker for the files near the view. */
function useHighlights(repoId: number, base: string, head: string, count: number) {
  const src = useSource();
  const [hl, setHl] = useState<(Highlight | null | undefined)[]>(() => new Array<Highlight | null | undefined>(count).fill(undefined));
  const [asked] = useState(() => new Set<number>());
  const want = useCallback((f: number) => {
    if (asked.has(f)) return;
    asked.add(f);
    src.diffHighlight(repoId, base, head, f).then((h) => {
      setHl((prev) => {
        const next = prev.slice();
        next[f] = h;
        return next;
      });
    }, () => undefined);
  }, [src, repoId, base, head, asked]);
  return {hl, want};
}

export const DiffView = observer(function DiffView({repoId, base, head, files, scroller, extras, onFile, ref}: DiffViewProps) {
  const {rows, fileRow} = useMemo(() => diffRows(files, extras ? {threads: extras.threads, notes: extras.notes, collapsed: extras.collapsed} : {}), [files, extras]);
  const [place, margin] = useScrollMargin(scroller);
  // Stable per row list: the virtualizer recomputes every row's position (O(rows)) whenever these change.
  const estimateSize = useCallback((i: number) => {
    const t = rows[i]?.t;
    return t === 'file' ? FILE_ROW : t === 'empty' ? EMPTY_ROW : t === 'thread' || t === 'notes' ? 120 : LINE;
  }, [rows]);
  const getItemKey = useCallback((i: number) => rowKey(rows[i]), [rows]);
  const getScrollElement = useCallback(() => scroller, [scroller]);
  const v = useVirtualizer({count: rows.length, getScrollElement, estimateSize, overscan: 40, scrollMargin: margin, getItemKey});
  const {hl, want} = useHighlights(repoId, base, head, files.length);
  const items = v.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  const fileFirst = fileAt(fileRow, first);
  const fileLast = fileAt(fileRow, last);
  // The file whose rows are at the top of the view (not the overscan).
  const topRow = items.find((it) => it.end - margin > (scroller?.scrollTop ?? 0))?.index ?? first;
  const current = fileAt(fileRow, topRow);
  useEffect(() => {
    for (let f = fileFirst; f <= fileLast; f++) want(f);
  }, [fileFirst, fileLast, want]);
  useEffect(() => {
    onFile?.(current);
  }, [current, onFile]);
  const toFile = useCallback((f: number) => {
    const r = fileRow[Math.max(0, Math.min(files.length - 1, f))];
    if (r !== undefined) v.scrollToIndex(r, {align: 'start'});
  }, [fileRow, files.length, v]);
  useImperativeHandle(ref, () => ({
    toFile,
    toLine(f: number, l: number) {
      const r = rows.findIndex((x) => x.t === 'line' && x.f === f && x.l === l);
      if (r >= 0) v.scrollToIndex(r, {align: 'center'});
    },
    current: () => current,
  }), [toFile, rows, v, current]);
  useShortcutScope('diff');
  useShortcut('diff.nextFile', () => {
    toFile(current + 1);
  });
  useShortcut('diff.prevFile', () => {
    // On a file's first row: the previous file; inside a file: its own header first.
    toFile(topRow === fileRow[current] ? current - 1 : current);
  });
  if (!files.length) return <EmptyState icon={MessageSquarePlus} title="No changes" description="These two commits have the same content."/>;
  const floating = topRow !== fileRow[current] && files[current];
  return (
    <div ref={place} className="relative">
      {/* The file in view, over the rows (it takes no space). */}
      {floating && (
        <div className="sticky top-0 z-sticky h-0">
          <FileHeader file={floating} f={current} extras={extras} floating/>
        </div>
      )}
      <div role="list" aria-label="Changes" className="relative" style={{height: v.getTotalSize()}}>
        {items.map((it) => {
          const row = rows[it.index];
          if (!row) return null;
          const measured = row.t === 'thread' || row.t === 'notes';
          return (
            <div key={it.key} role="listitem" data-index={it.index} ref={measured ? v.measureElement : undefined}
              className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start - margin)}px)`}}>
              <RowView row={row} file={files[row.f]} hl={hl[row.f]} extras={extras}/>
            </div>
          );
        })}
      </div>
    </div>
  );
});

function rowKey(r: Row | undefined): string {
  if (!r) return '';
  switch (r.t) {
    case 'file': case 'notes': case 'empty':
      return `${r.t}${String(r.f)}`;
    case 'hunk':
      return `h${String(r.f)}:${String(r.h)}`;
    case 'line': case 'thread':
      return `${r.t}${String(r.f)}:${String(r.l)}`;
  }
}

const RowView = memo(function RowView({row, file, hl, extras}: {row: Row; file: DiffFile | undefined; hl: Highlight | null | undefined; extras: DiffExtras | undefined}) {
  if (!file) return null;
  switch (row.t) {
    case 'file':
      return <div className="pt-2"><FileHeader file={file} f={row.f} extras={extras}/></div>;
    case 'notes':
      return extras?.notesOf(row.f) ?? null;
    case 'empty':
      return <div className="flex h-row items-center px-4 text-sm text-fg-subtle">{emptyReason(file)}</div>;
    case 'hunk': {
      const h = file.hunks[row.h];
      if (!h) return null;
      return (
        <CodeLine tone="hunk" gutter={<><LineNo n={0}/><LineNo n={0}/></>}>
          {`@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@${h.section ? ` ${h.section}` : ''}`}
        </CodeLine>
      );
    }
    case 'line': {
      const l = file.lines[row.l];
      if (!l) return null;
      const comment = extras?.onComment;
      return (
        <CodeLine tone={l.k === ADD ? 'add' : l.k === DEL ? 'del' : 'none'}
          gutter={<><LineNo n={l.o} label={l.o ? `old ${String(l.o)}` : undefined}/><LineNo n={l.n} label={l.n ? `new ${String(l.n)}` : undefined}/></>}
          trailing={comment && (
            <LineAction label={`Comment on line ${String(l.k === DEL ? l.o : l.n)}`} onClick={() => {
              comment(row.f, row.l);
            }}/>
          )}>
          <span className="inline-block w-3 text-fg-subtle select-none">{l.k === ADD ? '+' : l.k === DEL ? '−' : ' '}</span>
          <CodeTokens text={l.t} hl={hl} line={row.l}/>
        </CodeLine>
      );
    }
    case 'thread':
      return extras?.thread(row.f, row.l) ?? null;
  }
});

function emptyReason(f: DiffFile): string {
  if (f.binary) return 'Binary file not shown.';
  if (f.oldMode && f.newMode && f.oldMode !== f.newMode) return `Mode changed from ${f.oldMode} to ${f.newMode}.`;
  if (f.status === 'renamed') return 'Renamed without changes.';
  return 'Empty file.';
}

const FileHeader = memo(function FileHeader({file, f, extras, floating = false}: {file: DiffFile; f: number; extras: DiffExtras | undefined; floating?: boolean}) {
  const collapsed = extras?.collapsed.has(f) ?? false;
  return (
    <CodeFileHeader path={filePath(file)} oldPath={file.status === 'renamed' ? file.oldPath : undefined} status={STATUS[file.status]}
      stat={<DiffStat additions={file.additions} deletions={file.deletions}/>}
      leading={extras && !floating ? (
        <IconButton size="sm" icon={collapsed ? ChevronRight : ChevronDown} label={collapsed ? 'Expand the file' : 'Collapse the file'} aria-expanded={!collapsed} onClick={() => {
          extras.onToggle(f);
        }}/>
      ) : undefined}>
      {extras?.fileActions(f)}
    </CodeFileHeader>
  );
});
