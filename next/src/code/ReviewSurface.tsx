// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CodeView, type CodeViewHandle, useStableCallback} from '@pierre/diffs/react';
import type {CodeViewItem, DiffLineAnnotation, FileDiffMetadata, SelectionSide} from '@pierre/diffs';
import {useTheme} from '@primer/react';
import {ChevronDownIcon, ChevronRightIcon, PlusIcon} from '@primer/octicons-react';
import {IconButton} from '@primer/react';
import {useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../app/shortcuts/index.ts';
import type {DiffViewProps} from '../features/code/DiffView.tsx';
import {useDiffSettings} from '../features/code/DiffSettings.tsx';
import {ImageDiff, isImageDiff} from '../features/code/ImageDiff.tsx';
import {useSource} from '../features/code/hooks.ts';
import {useViewSize} from '../features/code/Lines.tsx';
import {ADD, DEL, type DiffFile, filePath} from './diff.ts';
import {CodeFileHeader, DiffStat} from './parts.tsx';
import {pierreFile} from './pierrePatch.ts';
import {PierreProvider, renderOptions, themeOptions} from './PierreProvider.tsx';

interface Annotation {f: number; l: number; notes?: boolean; image?: boolean; empty?: string}
const idOf = (f: number) => `file:${String(f)}`;
const fileOf = (id: string) => Number(id.slice(id.indexOf(':') + 1));

/** Paired +/- line in a split change block (no scan of other files or hunks). */
function otherSide(file: DiffFile | undefined, index: number, additions: boolean): number {
  const kind = file?.lines[index]?.k;
  if (!file || (kind !== ADD && kind !== DEL) || additions === (kind === ADD)) return index;
  let start = index;
  while (start > 0 && file.lines[start - 1]?.k === kind) start--;
  if (kind === DEL) {
    let end = index;
    while (file.lines[end]?.k === DEL) end++;
    const paired = end + index - start;
    return file.lines[paired]?.k === ADD ? paired : index;
  }
  let deleted = start;
  while (deleted > 0 && file.lines[deleted - 1]?.k === DEL) deleted--;
  const paired = deleted + index - start;
  return paired < start && file.lines[paired]?.k === DEL ? paired : index;
}

function emptyReason(file: DiffFile): string {
  if (file.binary) return 'Binary file not shown.';
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) return `Mode changed from ${file.oldMode} to ${file.newMode}.`;
  if (file.status === 'renamed') return 'Renamed without changes.';
  return 'Empty file.';
}

const sideOf = (k: number): SelectionSide => (k === DEL ? 'deletions' : 'additions');

/** Pierre moves one gutter button between lines: its name follows the line under the pointer. */
function CommentButton({getLine, onComment}: {getLine: () => {lineNumber: number; side?: SelectionSide} | undefined; onComment: (range: boolean) => void}) {
  const labelOf = () => {
    const line = getLine();
    return line ? `Comment on ${line.side === 'deletions' ? 'old ' : ''}line ${String(line.lineNumber)}` : 'Comment on line';
  };
  const [label, setLabel] = useState(labelOf);
  const labelLine = () => {setLabel(labelOf());};
  // Primer's smallest IconButton is taller than a code line: the gutter fits a line-high button.
  return <button type="button" aria-label={label} className="flex size-line items-center justify-center rounded-md bg-accent-emphasis text-onEmphasis"
    onPointerEnter={labelLine} onFocus={labelLine} onClick={(event) => {onComment(event.shiftKey);}}><PlusIcon size={12}/></button>;
}

/** Every file of a diff in Pierre's virtualized CodeView, with review threads as line annotations. */
export function ReviewSurface(props: DiffViewProps) {
  useViewSize(props.scroller);
  return <PierreProvider>{(plain) => <ReviewBody {...props} plain={plain}/>}</PierreProvider>;
}

/** FNV-1a: a file's item version follows its own annotations, so CodeView re-renders only files whose threads changed. */
function versionOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function useItems(files: readonly DiffFile[], cacheKey: string, extras: DiffViewProps['extras'], plain: boolean): CodeViewItem<Annotation>[] {
  const models = useMemo(() => files.map((file, f) => pierreFile(file, `${cacheKey}:${String(f)}`)), [files, cacheKey]);
  const threads = useMemo(() => {
    const byFile = new Map<number, number[]>();
    for (const key of extras?.threads ?? []) {
      const at = key.indexOf(':');
      const f = Number(key.slice(0, at));
      const list = byFile.get(f) ?? [];
      list.push(Number(key.slice(at + 1)));
      byFile.set(f, list);
    }
    return byFile;
  }, [extras?.threads]);
  const notes = extras?.notes;
  const collapsedFiles = extras?.collapsed;
  return useMemo(() => models.map((model, f) => {
    const file = files[f];
    const lines = threads.get(f) ?? [];
    const withNotes = notes?.has(f) ?? false;
    const collapsed = collapsedFiles?.has(f) ?? false;
    const annotations: DiffLineAnnotation<Annotation>[] = [];
    if (file && !file.lines.length) annotations.push({side: 'additions', lineNumber: 0, metadata: {f, l: -1, ...(isImageDiff(file) ? {image: true} : {empty: emptyReason(file)})}});
    if (withNotes) annotations.push({side: 'additions', lineNumber: 0, metadata: {f, l: -1, notes: true}});
    for (const l of lines) {
      const line = file?.lines[l];
      if (line) annotations.push({side: sideOf(line.k), lineNumber: line.k === DEL ? line.o : line.n, metadata: {f, l}});
    }
    return {id: idOf(f), type: 'diff' as const, fileDiff: plain ? {...model, lang: 'text' as const} : model, annotations, collapsed,
      version: versionOf(`${model.cacheKey ?? ''}|${String(plain)}|${String(withNotes)}|${String(collapsed)}|${lines.join(',')}`)};
  }), [models, files, threads, notes, collapsedFiles, plain]);
}

function ReviewBody({repoId, base, head, files, scroller, extras, onFile, underBar = false, ref, plain}: DiffViewProps & {plain: boolean}) {
  const source = useSource();
  const {split, whitespace} = useDiffSettings();
  const {resolvedColorScheme} = useTheme();
  const dark = resolvedColorScheme === 'dark';
  const viewer = useRef<CodeViewHandle<Annotation, undefined>>(null);
  const host = useRef<HTMLDivElement>(null);
  const cursorId = useId();
  const [current, setCurrent] = useState(0);
  const [cursor, setCursor] = useState<{f: number; l: number} | null>(null);
  const currentRef = useRef(0);
  const pending = useRef<{f: number; l?: number} | null>(null);
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const bar = underBar ? scroller?.querySelector<HTMLElement>('[data-sticky-bar]') : null;
    if (!bar) return undefined;
    const ro = new ResizeObserver(() => {setInset(bar.offsetHeight);});
    ro.observe(bar);
    return () => {ro.disconnect();};
  }, [underBar, scroller]);
  const items = useItems(files, `${String(repoId)}:${base}:${head}:${whitespace}`, extras, plain);
  const lineIndex = useCallback((f: number, n: number, side: SelectionSide) => files[f]?.lines.findIndex((l) => side === 'deletions' ? l.o === n && l.k !== ADD : l.n === n && l.k !== DEL) ?? -1, [files]);
  /** Brings the viewer itself into the page scroller's view, below a sticky bar. */
  const reveal = useCallback(() => {
    const el = host.current;
    if (!el || !scroller) return;
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset;
    if (offset > 0) scroller.scrollBy({top: offset});
  }, [scroller, inset]);
  const jump = useCallback((f: number, l?: number) => {
    const target = Math.max(0, Math.min(files.length - 1, f));
    pending.current = {f: target, ...(l !== undefined ? {l} : {})};
    currentRef.current = target;
    setCurrent(target);
    const line = l === undefined ? undefined : files[target]?.lines[l];
    setCursor(l === undefined ? null : {f: target, l});
    reveal();
    if (line) viewer.current?.scrollTo({type: 'line', id: idOf(target), lineNumber: line.k === DEL ? line.o : line.n, side: sideOf(line.k), align: 'center'});
    else viewer.current?.scrollTo({type: 'item', id: idOf(target), align: 'start'});
  }, [files, reveal]);
  useImperativeHandle(ref, () => ({toFile: jump, toLine: jump, current: () => cursor?.f ?? currentRef.current, focus: () => {
    host.current?.focus({preventScroll: true});
  }}), [jump, cursor]);
  useEffect(() => {onFile?.(current);}, [current, onFile]);
  useShortcutScope('diff');
  useShortcut('diff.nextFile', () => {jump((cursor?.f ?? currentRef.current) + 1);});
  useShortcut('diff.prevFile', () => {jump((cursor?.f ?? currentRef.current) - 1);});
  const comment = useStableCallback((f: number, l: number, range?: boolean) => {
    if (l >= 0 && (extras?.commentable?.(f, l) ?? true)) extras?.onComment?.(f, l, range ?? false);
  });
  const loadDiffFiles = useStableCallback(async (diff: FileDiffMetadata) => {
    const file = files.find((x) => filePath(x) === diff.name);
    if (!file) throw new Error('File unavailable');
    const [old, next] = await Promise.all([file.status === 'added' ? null : source.raw(repoId, base, file.oldPath), file.status === 'deleted' ? null : source.raw(repoId, head, file.newPath)]);
    if ((old && old.kind !== 'text') || (next && next.kind !== 'text')) throw new Error('File is not text');
    return {oldFile: {name: file.oldPath, contents: old?.kind === 'text' ? old.text : ''}, newFile: {name: file.newPath, contents: next?.kind === 'text' ? next.text : ''}};
  });
  // The clicked line becomes the cursor and the selection, which carries the comment button (also on touch).
  const onLineClick = useStableCallback((line: {lineNumber: number; annotationSide?: SelectionSide}, context: {item: {id: string}}) => {
    const f = fileOf(context.item.id);
    const side = line.annotationSide === 'deletions' ? 'deletions' : 'additions';
    setCursor({f, l: lineIndex(f, line.lineNumber, side)});
    viewer.current?.setSelectedLines({id: context.item.id, range: {start: line.lineNumber, end: line.lineNumber, side}});
    host.current?.focus({preventScroll: true});
  });
  const onPostRender = useStableCallback(() => {
    const target = pending.current;
    pending.current = null;
    if (target) jump(target.f, target.l);
    pending.current = null;
  });
  const commentable = !!extras?.onComment;
  const options = useMemo(() => ({
    ...themeOptions(dark), ...renderOptions, diffStyle: split ? 'split' as const : 'unified' as const, stickyHeaders: true,
    enableLineSelection: true, enableGutterUtility: commentable, expansionLineCount: 40, loadDiffFiles, onLineClick, onPostRender,
  }), [dark, split, commentable, loadDiffFiles, onLineClick, onPostRender]);
  const renderCustomHeader = useCallback((item: CodeViewItem<Annotation>) => {
    const f = fileOf(item.id);
    const file = files[f];
    if (!file) return null;
    const collapsed = extras?.collapsed.has(f) ?? false;
    return <CodeFileHeader path={filePath(file)} {...(file.status === 'renamed' ? {oldPath: file.oldPath} : {})} stat={<DiffStat additions={file.additions} deletions={file.deletions}/>}
      leading={extras ? <IconButton icon={collapsed ? ChevronRightIcon : ChevronDownIcon} variant="invisible" size="small" aria-label={collapsed ? 'Expand the file' : 'Collapse the file'} aria-expanded={!collapsed} onClick={() => {extras.onToggle(f);}}/> : null}>{extras?.fileActions(f)}</CodeFileHeader>;
  }, [files, extras]);
  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<Annotation> | {metadata: Annotation}) => {
    const {f, l, notes, image, empty} = annotation.metadata;
    const file = files[f];
    if (image && file) return <ImageDiff repoId={repoId} base={base} head={head} file={file}/>;
    if (empty) return <p className="px-4 py-2 text-muted">{empty}</p>;
    return <div className="py-2 text-base text-default">{notes ? extras?.notesOf(f) : extras?.thread(f, l)}</div>;
  }, [files, extras, repoId, base, head]);
  const renderGutterUtility = useCallback((getHoveredLine: () => {lineNumber: number; side?: SelectionSide} | undefined, item: CodeViewItem<Annotation>) => <CommentButton getLine={getHoveredLine} onComment={(range) => {
    const line = getHoveredLine();
    if (!line) return;
    const f = fileOf(item.id);
    const selection = viewer.current?.getSelectedLines();
    const side = line.side === 'deletions' ? 'deletions' : 'additions';
    if (selection?.id === item.id && selection.range.start !== selection.range.end && (!selection.range.endSide || selection.range.endSide === selection.range.side)) {
      const start = lineIndex(f, Math.min(selection.range.start, selection.range.end), side);
      const end = lineIndex(f, Math.max(selection.range.start, selection.range.end), side);
      if (start >= 0 && end >= 0) {comment(f, start); comment(f, end, true); return;}
    }
    comment(f, lineIndex(f, line.lineNumber, side), range);
  }}/>, [lineIndex, comment]);
  const cursorFile = cursor ? files[cursor.f] : undefined;
  const cursorLine = cursor ? cursorFile?.lines[cursor.l] : undefined;
  return <div ref={host} role="list" aria-label="Changes" tabIndex={0} aria-activedescendant={cursor ? cursorId : undefined} className="outline-focus"
    aria-keyshortcuts={`ArrowUp ArrowDown${split ? ' ArrowLeft ArrowRight' : ''}${commentable ? ' Enter' : ''}`} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      const f = cursor?.f ?? currentRef.current;
      const l = cursor?.l ?? -1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        let target = f;
        let next = l < 0 ? 0 : l + step;
        while (target >= 0 && target < files.length && (next < 0 || next >= (files[target]?.lines.length ?? 0) || extras?.collapsed.has(target))) {
          target += step;
          next = step === 1 ? 0 : (files[target]?.lines.length ?? 0) - 1;
        }
        if (target < 0 || target >= files.length) return;
        jump(target, next);
        const line = files[target]?.lines[next];
        if (line) viewer.current?.setSelectedLines({id: idOf(target), range: {start: line.k === DEL ? line.o : line.n, end: line.k === DEL ? line.o : line.n, side: sideOf(line.k)}});
      } else if (split && cursor && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const additions = event.key === 'ArrowRight';
        const next = otherSide(files[f], l, additions);
        jump(f, next);
        const line = files[f]?.lines[next];
        const n = additions ? line?.n : line?.o;
        if (n) viewer.current?.setSelectedLines({id: idOf(f), range: {start: n, end: n, side: additions ? 'additions' : 'deletions'}});
      } else if (event.key === 'Enter' && cursor) {event.preventDefault(); comment(f, l, event.shiftKey);}
    }}>
    {cursor && <span id={cursorId} role="listitem" className="sr-only">{cursorFile ? filePath(cursorFile) : ''}, line {cursorLine?.k === DEL ? cursorLine.o : cursorLine?.n}: {cursorLine?.t}</span>}
    <CodeView ref={viewer} items={items} className="overflow-auto" style={{height: `calc(var(--view-height) - ${String(inset)}px)`}} options={options}
      onScroll={(top, instance) => {
        const first = instance.getRenderedItems().find((item) => (instance.getTopForItem(item.id) ?? 0) + item.element.offsetHeight > top);
        if (first) {const f = fileOf(first.id); currentRef.current = f; setCurrent(f);}
      }} renderCustomHeader={renderCustomHeader} renderAnnotation={renderAnnotation} renderGutterUtility={renderGutterUtility}/>
  </div>;
}
