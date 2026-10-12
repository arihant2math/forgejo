// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixed-height code rows and measured thread rows share one virtual list across files.
// Highlight files near the viewport; memoized rows limit updates to the highlighted file.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, type KeyboardEvent, memo, type ReactNode, type Ref, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {ADD, DEL, type DiffFile, filePath} from '../../code/diff.ts';
import {diffRows, fileAt, type Row} from '../../code/rows.ts';
import type {Highlight} from '../../code/source.ts';
import {CodeFileHeader, CodeLine, CodeTokens, DiffStat, LineAction, LineNo} from '../../code/parts.tsx';
import {clsx} from 'clsx';
import {ReviewSurface} from '../../code/ReviewSurface.tsx';
import {useSource} from './hooks.ts';
import {ImageDiff, isImageDiff} from './ImageDiff.tsx';
import {useDiffSettings} from './DiffSettings.tsx';
import {LINE, useScrollMargin, useViewSize} from './Lines.tsx';
import {ChevronDownIcon, ChevronRightIcon, FileDiffIcon} from '@primer/octicons-react';
import {Button, IconButton, Tooltip} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

/** A file header row: the Primer header (40px) after an 8px gap. */
export const FILE_ROW = 48;
const EMPTY_ROW = 40;

export interface DiffExtras {
  threads: ReadonlySet<string>;
  notes: ReadonlySet<number>;
  collapsed: ReadonlySet<number>;
  thread: (f: number, l: number) => ReactNode;
  notesOf: (f: number) => ReactNode;
  /** Starts a comment on line l of file f (undefined: no comments here, e.g. offline without the head). */
  onComment?: ((f: number, l: number, range?: boolean) => void) | undefined;
  /** Whether line l of file f takes a comment (default: every line, when onComment is set). */
  commentable?: ((f: number, l: number) => boolean) | undefined;
  fileActions: (f: number) => ReactNode;
  onToggle: (f: number) => void;
}

export interface DiffHandle {
  toFile(f: number): void;
  toLine(f: number, l: number): void;
  /** The file of the keyboard cursor, else the one in view. */
  current(): number;
  focus(): void;
}

export interface DiffViewProps {
  repoId: number;
  base: string;
  head: string;
  files: readonly DiffFile[];
  scroller: HTMLDivElement | null;
  extras?: DiffExtras | undefined;
  onFile?: ((f: number) => void) | undefined;
  /** Keep file jumps and the floating header below the measured data-sticky-bar. */
  underBar?: boolean | undefined;
  ref?: Ref<DiffHandle>;
}

const STATUS: Record<DiffFile['status'], string | undefined> = {added: 'added', deleted: 'deleted', renamed: 'renamed', copied: 'copied', modified: undefined};

function useHighlights(repoId: number, base: string, head: string, count: number, whitespace: string) {
  const src = useSource();
  const [hl, setHl] = useState<(Highlight | null | undefined)[]>(() => Array.from({length: count}, (_, f) => src.peekDiffHighlight(repoId, base, head, f, whitespace)));
  const [asked] = useState(() => new Set<number>(hl.flatMap((h, f) => (h === undefined ? [] : [f]))));
  const want = useCallback((f: number) => {
    if (asked.has(f)) return;
    asked.add(f);
    src.diffHighlight(repoId, base, head, f, whitespace).then((h) => {
      setHl((prev) => {
        const next = prev.slice();
        next[f] = h;
        return next;
      });
    }, () => {
      asked.delete(f); // Retry when the file next approaches the viewport.
    });
  }, [src, repoId, base, head, asked, whitespace]);
  return {hl, want};
}

const EXPAND_STEP = 40;

function useExpansion(repoId: number, head: string, files: readonly DiffFile[]) {
  const src = useSource();
  const [content, setContent] = useState<ReadonlyMap<number, readonly string[]>>(() => new Map());
  const [revealed, setRevealed] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
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
      void src.highlight(repoId, `${head}/${file.newPath}`, file.newPath, c.text).then((h) => {
        setHighlit((m) => new Map(m).set(f, h));
      }, () => undefined);
    }, () => {
      setFailed((x) => new Set(x).add(f));
    });
  }, [src, repoId, head, files, content]);
  return {content, revealed, failed, expand, highlit};
}

export const DiffView = observer(function DiffView(props: DiffViewProps) {
  const {whitespace} = useDiffSettings();
  // Without workers, render plain lines rather than running Shiki on the main thread.
  return typeof Worker === 'undefined' ? <DiffBody key={`${props.base}:${props.head}:${whitespace}`} {...props}/> :
    <ReviewSurface key={`${props.base}:${props.head}:${whitespace}`} {...props} fallback={(ref) => <DiffBody {...props} ref={ref}/>}/>;
});

const DiffBody = observer(function DiffBody({repoId, base, head, files, scroller, extras, onFile, underBar = false, ref}: DiffViewProps) {
  const {split, whitespace} = useDiffSettings();
  const {content, revealed, failed, expand, highlit} = useExpansion(repoId, head, files);
  const {rows, fileRow} = useMemo(() => diffRows(files, {
    ...(extras ? {threads: extras.threads, notes: extras.notes, collapsed: extras.collapsed} : {}), content, revealed, split,
  }), [files, extras, content, revealed, split]);
  const [place, margin] = useScrollMargin(scroller);
  useViewSize(scroller);
  // Stable per row list: the virtualizer recomputes every row's position (O(rows)) whenever these change.
  const estimateSize = useCallback((i: number) => {
    const t = rows[i]?.t;
    return t === 'file' ? FILE_ROW : t === 'empty' ? EMPTY_ROW : t === 'hunk' ? 32 : t === 'thread' || t === 'notes' ? 120 : LINE;
  }, [rows]);
  const getItemKey = useCallback((i: number) => rowKey(rows[i]), [rows]);
  const getScrollElement = useCallback(() => scroller, [scroller]);
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    setInset(underBar ? scroller?.querySelector<HTMLElement>('[data-sticky-bar]')?.offsetHeight ?? 0 : 0);
  }, [underBar, scroller]);
  const v = useVirtualizer({
    count: rows.length, getScrollElement, estimateSize, overscan: 8, scrollMargin: margin, getItemKey, scrollPaddingStart: inset,
    // Do not force every entering code row (and its comment action) to mount inside the scroll event.
    useFlushSync: false,
  });
  const {hl, want} = useHighlights(repoId, base, head, files.length, whitespace);
  // Shared width keeps row tints aligned while scrolling sideways.
  const chars = useMemo(() => {
    let n = 0;
    for (const f of files) for (const l of f.lines) if (l.t.length > n) n = l.t.length;
    return n;
  }, [files]);
  const [cursor, setCursor] = useState(-1);
  const [rightSide, setRightSide] = useState(false);
  useEffect(() => { setCursor(-1); }, [files, split]);
  const listId = useId();
  const items = v.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  const fileFirst = fileAt(fileRow, first);
  const fileLast = fileAt(fileRow, last);
  const topRow = items.find((it) => it.end - margin > (scroller?.scrollTop ?? 0) + inset)?.index ?? Math.max(0, rows.length - 1);
  const current = fileAt(fileRow, topRow);
  useEffect(() => {
    for (let f = fileFirst; f <= fileLast; f++) want(f);
  }, [fileFirst, fileLast, want]);
  useEffect(() => {
    onFile?.(current);
  }, [current, onFile]);
  const listRef = useRef<HTMLDivElement>(null);
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
      const r = rows.findIndex((x) => x.t === 'line' && x.f === f && (x.l === l || x.right === l));
      if (r >= 0) {
        v.scrollToIndex(r, {align: 'center'});
        setCursor(r);
        const row = rows[r];
        setRightSide(row?.t === 'line' && row.right === l);
      }
    },
    current: () => (cursor >= 0 ? fileAt(fileRow, cursor) : current),
    focus: () => listRef.current?.focus({preventScroll: true}),
  }), [toFile, rows, v, current, cursor, fileRow]);
  useShortcutScope('diff');
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
  /** Touch needs a persistent comment button; do not steal focus from nested controls. */
  const pick = (index: number, target: EventTarget) => {
    setCursor(index);
    const side = target instanceof Element ? target.closest('[data-side]')?.getAttribute('data-side') : undefined;
    if (side) setRightSide(side === 'right');
    if (!(target instanceof Element && target.closest('a, button'))) listRef.current?.focus({preventScroll: true});
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // a composer inside a thread keeps its keys
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (split && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) setRightSide(e.key === 'ArrowRight');
    else if (e.key === 'Enter' && cursor >= 0 && extras?.onComment) {
      const r = rows[cursor];
      const l = r?.t === 'line' ? rightSide ? r.right ?? r.l : r.l : undefined;
      if (r && l !== undefined && (extras.commentable?.(r.f, l) ?? true)) extras.onComment(r.f, l);
    } else return;
    e.preventDefault();
  };
  const lastFileStart = v.measurementsCache[fileRow[files.length - 1] ?? 0]?.start ?? 0;
  const lastFileHeight = Math.max(0, v.getTotalSize() - (lastFileStart - margin));
  if (!files.length) return <Blankslate><Blankslate.Visual><FileDiffIcon size={24}/></Blankslate.Visual><Blankslate.Heading>No changes</Blankslate.Heading><Blankslate.Description>{whitespace ? 'No changes remain with whitespace hidden.' : 'These two commits have the same content.'}</Blankslate.Description></Blankslate>;
  const floating = topRow !== fileRow[current] && files[current];
  const active = rows[cursor];
  return (
    <div ref={place} className="relative min-w-code font-mono" style={{'--code-chars': split ? chars * 2 : chars} as CSSProperties}>
      {floating && (
        <div className={clsx('sticky z-sticky h-0', underBar ? 'top-control' : 'top-0')}>
          <div className="sticky left-0 w-view font-sans"><FileHeader file={floating} f={current} extras={extras} floating/></div>
        </div>
      )}
      <div ref={listRef} role="list" aria-label="Changes" tabIndex={0} onKeyDown={onKeyDown}
        aria-activedescendant={active?.t === 'line' ? `${listId}-${String(cursor)}` : undefined}
        aria-keyshortcuts={`ArrowUp ArrowDown${split ? ' ArrowLeft ArrowRight' : ''}${extras?.onComment ? ' Enter' : ''}`}
        className="relative focus-visible:outline-offset-0" style={{height: v.getTotalSize()}}>
        {items.map((it) => {
          const row = rows[it.index];
          if (!row) return null;
          const file = files[row.f];
          const image = row.t === 'empty' && file && isImageDiff(file);
          const measured = row.t === 'thread' || row.t === 'notes' || image;
          return (
            <div key={it.key} role="listitem" data-index={it.index} ref={measured ? v.measureElement : undefined}
              className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(it.start - margin)}px)`}}
              onClick={row.t === 'line' ? (e) => {
                pick(it.index, e.target);
              } : undefined}>
              {image ? <ImageDiff repoId={repoId} base={base} head={head} file={file}/> : <RowView row={row} id={`${listId}-${String(it.index)}`} active={it.index === cursor} file={files[row.f]} hl={row.t === 'extra' ? highlit.get(row.f) : hl[row.f]}
                extras={extras} split={split} rightSide={rightSide} onExpand={failed.has(row.f) ? undefined : expand}/>  }
            </div>
          );
        })}
      </div>
      {/* Let the last file reach the top without leaving a blank viewport below it. */}
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

const RowView = memo(function RowView({row, id, active, file, hl, extras, onExpand, split, rightSide}: {
  row: Row; id: string; active: boolean; file: DiffFile | undefined; hl: Highlight | null | undefined; extras: DiffExtras | undefined;
  split: boolean; rightSide: boolean;
  onExpand: ((f: number, h: number, all: boolean) => void) | undefined;
}) {
  if (!file) return null;
  switch (row.t) {
    case 'file':
      return <div className="sticky left-0 w-view pt-2 font-sans"><FileHeader file={file} f={row.f} extras={extras}/></div>;
    case 'notes':
      return <div className="sticky left-0 w-view py-2 font-sans text-base text-default">{extras?.notesOf(row.f)}</div>;
    case 'empty':
      return <div className="sticky left-0 flex h-row w-view items-center px-4 font-sans text-sm text-muted">{emptyReason(file)}</div>;
    case 'hunk': {
      const h = file.hunks[row.h];
      if (!h) return null;
      const expandable = row.hidden > 0 && onExpand && file.status !== 'deleted' && !file.binary;
      return (
        <CodeLine tone="hunk" gutter={<><LineNo n={0}/><LineNo n={0}/><span className="inline-block w-3"/></>}
          trailing={expandable && (
            // Sticky controls need an opaque background to cover hunk text on narrow views.
            <span className="sticky right-0 ml-auto flex items-center gap-2 self-stretch bg-muted px-2 font-sans">
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
      if (split) return <div className="flex divide-x divide-muted">
        {[row.o, row.n].map((n, side) => <div key={side} className="min-w-0 flex-1"><CodeLine gutter={<LineNo n={n}/>}><CodeTokens text={row.text} hl={hl} line={row.n - 1}/></CodeLine></div>)}
      </div>;
      return (
        <CodeLine gutter={<><LineNo n={row.o}/><LineNo n={row.n}/><span className="inline-block w-3"/></>}><CodeTokens text={row.text} hl={hl} line={row.n - 1}/></CodeLine>
      );
    case 'line': {
      const l = file.lines[row.l];
      if (!l) return null;
      const onComment = extras?.onComment;
      const comment = onComment && (extras.commentable?.(row.f, row.l) ?? true) ? onComment : undefined;
      if (split) {
        const left = l.k === ADD ? undefined : row.l;
        const right = row.right ?? (l.k === DEL ? undefined : row.l);
        const selected = rightSide ? right ?? left : left ?? right;
        return <div className="flex divide-x divide-muted">
          {[left, right].map((index, side) => {
            const line = index === undefined ? undefined : file.lines[index];
            return <div key={side} data-side={side === 0 ? 'left' : 'right'} className="min-w-0 flex-1 overflow-hidden">
              <CodeLine id={index === selected && (side === 0 || left !== right) ? id : undefined} active={active && index === selected && (side === 0 || left !== right)} tone={line?.k === ADD ? 'add' : line?.k === DEL ? 'del' : 'none'}
                gutter={<LineNo n={line ? side === 0 ? line.o : line.n : 0}/>}
                action={line && index !== undefined && onComment && (extras.commentable?.(row.f, index) ?? true) && <LineAction label={`Comment on ${side === 0 ? 'old' : 'new'} line ${String(side === 0 ? line.o : line.n)}`} onClick={() => { onComment(row.f, index); }}/>}>
                {line && index !== undefined ? <CodeTokens text={line.t} hl={hl} line={index}/> : ' '}
              </CodeLine>
            </div>;
          })}
        </div>;
      }
      return (
        <CodeLine id={id} active={active} tone={l.k === ADD ? 'add' : l.k === DEL ? 'del' : 'none'}
          gutter={<><LineNo n={l.o}/><LineNo n={l.n} onPick={comment ? (_n, range) => {comment(row.f, row.l, range);} : undefined}/><span className="inline-block w-3 text-muted select-none">{l.k === ADD ? '+' : l.k === DEL ? '−' : ' '}</span></>}
          action={comment && (
            <LineAction label={`Comment on line ${String(l.k === DEL ? l.o : l.n)}`} onClick={() => {
              comment(row.f, row.l);
            }}/>
          )}>
          <CodeTokens text={l.t} hl={hl} line={row.l}/>
        </CodeLine>
      );
    }
    case 'thread':
      return <div className="sticky left-0 w-view py-2 font-sans text-base text-default">{extras?.thread(row.f, row.l)}</div>;
  }
});

function ExpandButton({label, onClick, children}: {label: string; onClick: () => void; children: string}) {
  return <Tooltip text={label}><Button variant="invisible" size="small" type="button" aria-label={label} onClick={onClick}>{children}</Button></Tooltip>;
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
        <IconButton icon={collapsed ? ChevronRightIcon : ChevronDownIcon} variant="invisible" size="small" aria-label={collapsed ? 'Expand the file' : 'Collapse the file'} type="button" aria-expanded={!collapsed} onClick={() => {
          extras.onToggle(f);
        }}/>
      ) : undefined}>
      {extras?.fileActions(f)}
    </CodeFileHeader>
  );
});

const OPEN_FILES = 12;

/** Keep the file list pinned while wide diff lines scroll sideways. */
export function ChangedFiles({files, diff}: {files: readonly DiffFile[]; diff: {current: DiffHandle | null}}) {
  const [open, setOpen] = useState(files.length <= OPEN_FILES);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <section aria-label="Changed files" className="sticky left-0 w-view border-b border-muted py-1">
      <div className="flex h-control items-center gap-2 px-4 text-base text-default">
        <IconButton icon={open ? ChevronDownIcon : ChevronRightIcon} variant="invisible" size="small" aria-label={open ? 'Hide the files' : 'Show the files'} type="button" aria-expanded={open} onClick={() => {
          setOpen((o) => !o);
        }}/>
        <span className="text-default">{files.length} {files.length === 1 ? 'file' : 'files'} changed</span>
        <DiffStat additions={additions} deletions={deletions}/>
      </div>
      {open && files.map((f, i) => (
        <a className="flex items-center gap-2 px-4 py-2 text-base text-default hover:bg-control-transparent-hover hover:text-accent hover:underline" key={`${filePath(f)}:${String(i)}`} href={`#${encodeURIComponent(filePath(f))}`}
          onClick={(e) => {
            e.preventDefault();
            diff.current?.toFile(i);
          }}>
          <FileDiffIcon size={16}/><span className="min-w-0 flex-1 truncate" title={filePath(f)}>{filePath(f)}</span><DiffStat additions={f.additions} deletions={f.deletions}/>
        </a>
      ))}
    </section>
  );
}
