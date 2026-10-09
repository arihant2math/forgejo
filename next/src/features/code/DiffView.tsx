// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A diff, virtualized per row (PLAN §5.7): one list for every file of a
// commit, a compare or a pull request (code/rows.ts). Code rows have one
// fixed height; only thread rows (comments, drafts, a composer) are
// measured. Highlighting is per file, asked of the worker when a file's rows
// come near the view, and each row is memoized on its own data — a file's
// highlighting arriving re-renders that file's rows only, a scroll frame
// mounts the rows coming into view. A floating header names the file in
// view; `[` and `]` jump between files; ↑/↓ move a line cursor (Enter
// comments on it). A hunk's header expands the unchanged lines above it
// (from the new file at the head, asked once). Rows share the longest line's width (they scroll
// sideways together); headers and threads stay pinned to the view's left.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {ChevronDown, ChevronRight, FileDiff} from 'lucide-react';
import {type CSSProperties, type KeyboardEvent, memo, type ReactNode, type Ref, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {ADD, DEL, type DiffFile, filePath} from '../../code/diff.ts';
import {diffRows, fileAt, type Row} from '../../code/rows.ts';
import type {Highlight} from '../../code/source.ts';
import {Button, CodeFileHeader, CodeLine, CodeTokens, cx, DiffStat, EmptyState, IconButton, LineAction, LineNo} from '../../ui/index.ts';
import {useSource} from './hooks.ts';
import {LINE, useScrollMargin, useViewSize} from './Lines.tsx';

/** A file header row: the header (h-row, 32) after an 8 px gap. */
export const FILE_ROW = 40;
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
  /** The file of the keyboard cursor, else the one in view. */
  current(): number;
  /** Focuses the diff (its keyboard cursor). */
  focus(): void;
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
  /**
   * A sticky bar (h-control, marked data-sticky-bar) is pinned above the diff in the scroller (the pull request's
   * review bar): a file jumped to and the floating header go below it, not under it.
   */
  underBar?: boolean | undefined;
  ref?: Ref<DiffHandle>;
}

const STATUS: Record<DiffFile['status'], string | undefined> = {added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'copied', modified: undefined};

/** Per-file highlighting, asked of the worker for the files near the view. */
function useHighlights(repoId: number, base: string, head: string, count: number) {
  const src = useSource();
  // Files highlighted earlier this session paint highlighted in the first frame.
  const [hl, setHl] = useState<(Highlight | null | undefined)[]>(() => Array.from({length: count}, (_, f) => src.peekDiffHighlight(repoId, base, head, f)));
  const [asked] = useState(() => new Set<number>(hl.flatMap((h, f) => (h === undefined ? [] : [f]))));
  const want = useCallback((f: number) => {
    if (asked.has(f)) return;
    asked.add(f);
    src.diffHighlight(repoId, base, head, f).then((h) => {
      setHl((prev) => {
        const next = prev.slice();
        next[f] = h;
        return next;
      });
    }, () => {
      asked.delete(f); // not loaded (a grammar, the worker): asked again when the file is next near the view
    });
  }, [src, repoId, base, head, asked]);
  return {hl, want};
}

/** Unchanged lines one "expand" reveals above a hunk. */
const EXPAND_STEP = 40;

/** Hidden lines between hunks, expanded from the new file's content (asked once per file, cached by commit). */
function useExpansion(repoId: number, head: string, files: readonly DiffFile[]) {
  const src = useSource();
  const [content, setContent] = useState<ReadonlyMap<number, readonly string[]>>(() => new Map());
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
  // The head file's highlighting, for the expanded lines (they read like the diff's own lines).
  const [highlit, setHighlit] = useState<ReadonlyMap<number, Highlight | null>>(() => new Map());
  const expand = useCallback((f: number, h: number, all: boolean) => {
    const key = `${String(f)}:${String(h)}`;
    const more = () => {
      setRevealed((m) => new Map(m).set(key, all ? Number.MAX_SAFE_INTEGER : (m.get(key) ?? 0) + EXPAND_STEP));
    };
    const file = files[f];
    if (content.has(f) || !file) {
      more();
      return;
    }
    src.raw(repoId, head, file.newPath).then((c) => {
      if (c.kind !== 'text') throw new Error('not text');
      setContent((m) => new Map(m).set(f, c.text.split('\n')));
      more();
      // Cached by (head, path): the same file at the same commit is highlighted once.
      void src.highlight(repoId, `${head}/${file.newPath}`, file.newPath, c.text).then((h) => {
        setHighlit((m) => new Map(m).set(f, h));
      }, () => undefined);
    }, () => {
      setFailed((x) => new Set(x).add(f));
    });
  }, [src, repoId, head, files, content]);
  return {content, revealed, failed, expand, highlit};
}

export const DiffView = observer(function DiffView({repoId, base, head, files, scroller, extras, onFile, underBar = false, ref}: DiffViewProps) {
  const {content, revealed, failed, expand, highlit} = useExpansion(repoId, head, files);
  const {rows, fileRow} = useMemo(() => diffRows(files, {
    ...(extras ? {threads: extras.threads, notes: extras.notes, collapsed: extras.collapsed} : {}), content, revealed,
  }), [files, extras, content, revealed]);
  const [place, margin] = useScrollMargin(scroller);
  useViewSize(scroller);
  // Stable per row list: the virtualizer recomputes every row's position (O(rows)) whenever these change.
  const estimateSize = useCallback((i: number) => {
    const t = rows[i]?.t;
    return t === 'file' ? FILE_ROW : t === 'empty' ? EMPTY_ROW : t === 'thread' || t === 'notes' ? 120 : LINE;
  }, [rows]);
  const getItemKey = useCallback((i: number) => rowKey(rows[i]), [rows]);
  const getScrollElement = useCallback(() => scroller, [scroller]);
  // What the sticky bar covers at the top of the view (its own height: no number here), measured once.
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    setInset(underBar ? scroller?.querySelector<HTMLElement>('[data-sticky-bar]')?.offsetHeight ?? 0 : 0);
  }, [underBar, scroller]);
  const v = useVirtualizer({count: rows.length, getScrollElement, estimateSize, overscan: 40, scrollMargin: margin, getItemKey, scrollPaddingStart: inset});
  const {hl, want} = useHighlights(repoId, base, head, files.length);
  // The longest line (characters): every row is that wide, so tints span it and rows scroll sideways together.
  const chars = useMemo(() => {
    let n = 0;
    for (const f of files) for (const l of f.lines) if (l.t.length > n) n = l.t.length;
    return n;
  }, [files]);
  // The keyboard cursor: a line row (↑/↓; Enter comments), or -1.
  const [cursor, setCursor] = useState(-1);
  const listId = useId();
  const items = v.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  const fileFirst = fileAt(fileRow, first);
  const fileLast = fileAt(fileRow, last);
  // The file whose rows are at the top of the view, below the sticky bar (not the overscan); past the last row (the
  // room after it), the last one.
  const topRow = items.find((it) => it.end - margin > (scroller?.scrollTop ?? 0) + inset)?.index ?? Math.max(0, rows.length - 1);
  const current = fileAt(fileRow, topRow);
  useEffect(() => {
    for (let f = fileFirst; f <= fileLast; f++) want(f);
  }, [fileFirst, fileLast, want]);
  useEffect(() => {
    onFile?.(current);
  }, [current, onFile]);
  const listRef = useRef<HTMLDivElement>(null);
  /** The first line row of a file at or after row `from` (-1: none). */
  const lineFrom = useCallback((from: number, step: 1 | -1) => {
    for (let r = from; r >= 0 && r < rows.length; r += step) if (rows[r]?.t === 'line') return r;
    return -1;
  }, [rows]);
  const toFile = useCallback((f: number) => {
    const target = Math.max(0, Math.min(files.length - 1, f));
    const r = fileRow[target];
    if (r === undefined) return;
    v.scrollToIndex(r, {align: 'start'});
    const l = lineFrom(r, 1);
    setCursor(l >= 0 && fileAt(fileRow, l) === target ? l : -1);
  }, [fileRow, files.length, v, lineFrom]);
  useImperativeHandle(ref, () => ({
    toFile,
    toLine(f: number, l: number) {
      const r = rows.findIndex((x) => x.t === 'line' && x.f === f && x.l === l);
      if (r >= 0) {
        v.scrollToIndex(r, {align: 'center'});
        setCursor(r);
      }
    },
    current: () => (cursor >= 0 ? fileAt(fileRow, cursor) : current),
    focus: () => listRef.current?.focus({preventScroll: true}),
  }), [toFile, rows, v, current, cursor, fileRow]);
  useShortcutScope('diff');
  // The file of the cursor, else the one at the top of the view.
  const here = cursor >= 0 ? fileAt(fileRow, cursor) : current;
  useShortcut('diff.nextFile', () => {
    toFile(here + 1);
  });
  useShortcut('diff.prevFile', () => {
    // At a file's start: the previous file; inside a file: its own start first.
    const start = lineFrom(fileRow[here] ?? 0, 1);
    toFile(cursor === start || (cursor < 0 && topRow === fileRow[here]) ? here - 1 : here);
  });
  const move = (step: 1 | -1) => {
    const from = cursor < 0 ? lineFrom(topRow, 1) : lineFrom(cursor + step, step);
    if (from < 0) return;
    setCursor(from);
    v.scrollToIndex(from, {align: 'auto'});
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // a composer inside a thread keeps its keys
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && cursor >= 0 && extras?.onComment) {
      const r = rows[cursor];
      if (r?.t === 'line') extras.onComment(r.f, r.l);
    } else return;
    e.preventDefault();
  };
  const lastFileStart = v.measurementsCache[fileRow[files.length - 1] ?? 0]?.start ?? 0;
  const lastFileHeight = Math.max(0, v.getTotalSize() - (lastFileStart - margin));
  if (!files.length) return <EmptyState icon={FileDiff} title="No changes" description="These two commits have the same content."/>;
  const floating = topRow !== fileRow[current] && files[current];
  const active = rows[cursor];
  return (
    <div ref={place} className="relative min-w-code font-mono" style={{'--code-chars': chars} as CSSProperties}>
      {/* The file in view, over the rows (it takes no space), pinned to the view's left edge. */}
      {floating && (
        <div className={cx('sticky z-sticky h-0', underBar ? 'top-control' : 'top-0')}>
          <div className="sticky left-0 w-view font-sans"><FileHeader file={floating} f={current} extras={extras} floating/></div>
        </div>
      )}
      <div ref={listRef} role="list" aria-label="Changes" tabIndex={0} onKeyDown={onKeyDown}
        aria-activedescendant={active?.t === 'line' ? `${listId}-${String(cursor)}` : undefined}
        aria-keyshortcuts={extras?.onComment ? 'ArrowUp ArrowDown Enter' : 'ArrowUp ArrowDown'}
        className="relative focus-visible:outline-offset-0" style={{height: v.getTotalSize()}}>
        {items.map((it) => {
          const row = rows[it.index];
          if (!row) return null;
          const measured = row.t === 'thread' || row.t === 'notes';
          return (
            <div key={it.key} role="listitem" data-index={it.index} ref={measured ? v.measureElement : undefined}
              className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start - margin)}px)`}}>
              <RowView row={row} id={`${listId}-${String(it.index)}`} active={it.index === cursor} file={files[row.f]} hl={row.t === 'extra' ? highlit.get(row.f) : hl[row.f]}
                extras={extras} onExpand={failed.has(row.f) ? undefined : expand}/>
            </div>
          );
        })}
      </div>
      {/* Room after the last file, so that it can come to the top (`]`, the file in view): only what it lacks of a
          view's height (a short last file), never a blank view under it. */}
      <div aria-hidden style={{height: `max(0px, calc(var(--view-height) - ${String(lastFileHeight + inset)}px))`}}/>
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
    case 'extra':
      return `x${String(r.f)}:${String(r.n)}`;
    case 'line': case 'thread':
      return `${r.t}${String(r.f)}:${String(r.l)}`;
  }
}

const RowView = memo(function RowView({row, id, active, file, hl, extras, onExpand}: {
  row: Row; id: string; active: boolean; file: DiffFile | undefined; hl: Highlight | null | undefined; extras: DiffExtras | undefined;
  onExpand: ((f: number, h: number, all: boolean) => void) | undefined;
}) {
  if (!file) return null;
  switch (row.t) {
    case 'file':
      return <div className="sticky left-0 w-view pt-2 font-sans"><FileHeader file={file} f={row.f} extras={extras}/></div>;
    case 'notes':
      return <div className="sticky left-0 w-view font-sans">{extras?.notesOf(row.f)}</div>;
    case 'empty':
      return <div className="sticky left-0 flex h-row w-view items-center px-4 font-sans text-sm text-fg-subtle">{emptyReason(file)}</div>;
    case 'hunk': {
      const h = file.hunks[row.h];
      if (!h) return null;
      // Hidden unchanged lines above it (not for a deleted file: there is no new file to read them from).
      const expandable = row.hidden > 0 && onExpand && file.status !== 'deleted' && !file.binary;
      return (
        <CodeLine tone="hunk" gutter={<><LineNo n={0}/><LineNo n={0}/><span className="inline-block w-3"/></>}
          trailing={expandable && (
            // Opaque (the row's own background): pinned to the right on a narrow view, it covers the header's text.
            <span className="sticky right-0 flex items-center gap-1 bg-inherit pr-2 pl-2 font-sans">
              <ExpandButton label={`Show ${String(Math.min(row.hidden, EXPAND_STEP))} more unchanged lines`} onClick={() => {
                onExpand(row.f, row.h, false);
              }}>{row.hidden > EXPAND_STEP ? `Expand ${String(EXPAND_STEP)}` : 'Expand'}</ExpandButton>
              {row.hidden > EXPAND_STEP && <ExpandButton label={`Show all ${String(row.hidden)} unchanged lines`} onClick={() => {
                onExpand(row.f, row.h, true);
              }}>{`All ${String(row.hidden)}`}</ExpandButton>}
            </span>
          )}>
          {`@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@${h.section ? ` ${h.section}` : ''}`}
        </CodeLine>
      );
    }
    case 'extra':
      // `hl` is the head file's highlighting here (its line n - 1).
      return (
        <CodeLine gutter={<><LineNo n={row.o}/><LineNo n={row.n}/><span className="inline-block w-3"/></>}><CodeTokens text={row.text} hl={hl} line={row.n - 1}/></CodeLine>
      );
    case 'line': {
      const l = file.lines[row.l];
      if (!l) return null;
      const comment = extras?.onComment;
      return (
        <CodeLine id={id} active={active} tone={l.k === ADD ? 'add' : l.k === DEL ? 'del' : 'none'}
          gutter={<><LineNo n={l.o}/><LineNo n={l.n}/><span className="inline-block w-3 text-fg-subtle select-none">{l.k === ADD ? '+' : l.k === DEL ? '−' : ' '}</span></>}
          trailing={comment && (
            <LineAction label={`Comment on line ${String(l.k === DEL ? l.o : l.n)}`} onClick={() => {
              comment(row.f, row.l);
            }}/>
          )}>
          <CodeTokens text={l.t} hl={hl} line={row.l}/>
        </CodeLine>
      );
    }
    case 'thread':
      return <div className="sticky left-0 w-view font-sans">{extras?.thread(row.f, row.l)}</div>;
  }
});

/** A hunk header's expand action (mouse and keyboard: a real button, in the header's own row). */
function ExpandButton({label, onClick, children}: {label: string; onClick: () => void; children: string}) {
  return <Button size="sm" variant="ghost" tooltip={label} aria-label={label} onClick={onClick}>{children}</Button>;
}

function emptyReason(f: DiffFile): string {
  if (f.binary) return 'Binary file not shown.';
  if (f.oldMode && f.newMode && f.oldMode !== f.newMode) return `Mode changed from ${f.oldMode} to ${f.newMode}.`;
  if (f.status === 'renamed') return 'Renamed without changes.';
  return 'Empty file.';
}

const FileHeader = memo(function FileHeader({file, f, extras}: {file: DiffFile; f: number; extras: DiffExtras | undefined; floating?: boolean}) {
  const collapsed = extras?.collapsed.has(f) ?? false;
  return (
    <CodeFileHeader path={filePath(file)} oldPath={file.status === 'renamed' ? file.oldPath : undefined} status={STATUS[file.status]}
      stat={<DiffStat additions={file.additions} deletions={file.deletions}/>}
      leading={extras ? (
        <IconButton size="sm" icon={collapsed ? ChevronRight : ChevronDown} label={collapsed ? 'Expand the file' : 'Collapse the file'} aria-expanded={!collapsed} onClick={() => {
          extras.onToggle(f);
        }}/>
      ) : undefined}>
      {extras?.fileActions(f)}
    </CodeFileHeader>
  );
});
