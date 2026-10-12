// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CodeView, type CodeViewHandle} from '@pierre/diffs/react';
import type {CodeViewItem, DiffLineAnnotation, FileDiffMetadata, SelectionSide} from '@pierre/diffs';
import {useTheme} from '@primer/react';
import {ChevronDownIcon, ChevronRightIcon, PlusIcon} from '@primer/octicons-react';
import {IconButton} from '@primer/react';
import {type ReactNode, type Ref, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../app/shortcuts/index.ts';
import {useApp} from '../app/store.ts';
import workerURL from '../workers/pierre.worker.ts?worker&url';
import {pierreWorker} from './pierreWorker.ts';
import {pierreHTMLSupported} from './pierreSupport.ts';
import type {DiffHandle, DiffViewProps} from '../features/code/DiffView.tsx';
import {useDiffSettings} from '../features/code/DiffSettings.tsx';
import {ImageDiff, isImageDiff} from '../features/code/ImageDiff.tsx';
import {useSource} from '../features/code/hooks.ts';
import {useViewSize} from '../features/code/Lines.tsx';
import {ADD, DEL, type DiffFile, filePath} from './diff.ts';
import {CodeFileHeader, DiffStat} from './parts.tsx';
import {githubTheme, PierreProvider, primerCodeCSS, WorkerReady} from './PierreProvider.tsx';

interface Annotation {f: number; l: number; notes?: boolean; image?: boolean; empty?: string}
const idOf = (f: number) => `file:${String(f)}`;

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

function CommentButton({getLine, onComment}: {getLine: () => {lineNumber: number} | undefined; onComment: (range: boolean) => void}) {
  const [label, setLabel] = useState('Comment on line');
  const labelLine = () => {const line = getLine(); if (line) setLabel(`Comment on line ${String(line.lineNumber)}`);};
  return <IconButton icon={PlusIcon} type="button" size="small" variant="primary" aria-label={label}
    onPointerEnter={labelLine} onFocus={labelLine} onClick={(event) => {onComment(event.shiftKey);}}/>;
}

/** Worker-parsed, worker-highlighted multi-file review. Threads remain our durable/offline React flows. */
export function ReviewSurface(props: DiffViewProps & {fallback: (ref: Ref<DiffHandle>) => ReactNode}) {
  // Forward the ref to the safe renderer; no ref.current is read here.
  // eslint-disable-next-line react-hooks/refs
  if (!pierreHTMLSupported()) return props.fallback(props.ref ?? null);
  return <PierreProvider><ReviewBody {...props}/></PierreProvider>;
}

function ReviewBody({repoId, base, head, files, scroller, extras, onFile, ref, fallback}: DiffViewProps & {fallback: (ref: Ref<DiffHandle>) => ReactNode}) {
  const source = useSource();
  const {config: {base: appBase}} = useApp();
  const {split, whitespace} = useDiffSettings();
  const {resolvedColorScheme} = useTheme();
  const viewer = useRef<CodeViewHandle<Annotation, undefined>>(null);
  const plain = useRef<DiffHandle>(null);
  const host = useRef<HTMLDivElement>(null);
  const cursorId = useId();
  const [metadata, setMetadata] = useState<FileDiffMetadata[]>();
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [cursor, setCursor] = useState<{f: number; l: number} | null>(null);
  const currentRef = useRef(0);
  const pending = useRef<{f: number; l?: number} | null>(null);
  useViewSize(scroller);
  useEffect(() => {
    let worker: Worker;
    try {worker = pierreWorker(appBase, workerURL, 'diffs-parse');}
    catch {void Promise.resolve().then(() => {setFailed(true);}); return undefined;}
    const timeout = setTimeout(() => {setFailed(true); worker.terminate();}, 30_000);
    worker.onmessage = (event: MessageEvent<{files?: FileDiffMetadata[]; error?: boolean}>) => {
      clearTimeout(timeout);
      if (event.data.files) {
        event.data.files.forEach((file, f) => {file.cacheKey = `${String(repoId)}:${base}:${head}:${whitespace}:${String(f)}`;});
        setMetadata(event.data.files);
      }
      else setFailed(true);
      worker.terminate();
    };
    worker.onerror = () => {clearTimeout(timeout); setFailed(true); worker.terminate();};
    worker.postMessage(files);
    return () => {clearTimeout(timeout); worker.terminate();};
  }, [files, repoId, base, head, whitespace, appBase]);

  const items = useMemo<CodeViewItem<Annotation>[]>(() => metadata?.map((fileDiff, f) => {
    const annotations: DiffLineAnnotation<Annotation>[] = [];
    const file = files[f];
    if (file && !file.lines.length) annotations.push({side: 'additions', lineNumber: 0, metadata: {f, l: -1,
      ...(isImageDiff(file) ? {image: true} : {empty: file.binary ? 'Binary file not shown.' : file.oldMode && file.newMode && file.oldMode !== file.newMode ? `Mode changed from ${file.oldMode} to ${file.newMode}.` : file.status === 'renamed' ? 'Renamed without changes.' : 'Empty file.'})}});
    if (extras?.notes.has(f)) annotations.push({side: 'additions', lineNumber: 0, metadata: {f, l: -1, notes: true}});
    for (const key of extras?.threads ?? []) {
      const [file, line] = key.split(':').map(Number);
      if (file !== f || line === undefined) continue;
      const l = files[f]?.lines[line];
      if (l) annotations.push({side: l.k === DEL ? 'deletions' : 'additions', lineNumber: l.k === DEL ? l.o : l.n, metadata: {f, l: line}});
    }
    return {id: idOf(f), type: 'diff', fileDiff, annotations, collapsed: extras?.collapsed.has(f) ?? false,
      // React owns the full item snapshots. Changed annotation renderers, not just counts, invalidate slots.
      version: 0};
  }) ?? [], [metadata, extras, files]);
  // CodeView compares versions, not React callback identities.
  const [revision, setRevision] = useState({items, value: 0});
  if (revision.items !== items) setRevision({items, value: revision.value + 1});
  const versioned = useMemo(() => items.map((item) => ({...item, version: revision.value})), [items, revision.value]);
  const lineIndex = useCallback((f: number, n: number, side: SelectionSide) => files[f]?.lines.findIndex((l) => side === 'deletions' ? l.o === n && l.k !== ADD : l.n === n && l.k !== DEL) ?? -1, [files]);
  const jump = useCallback((f: number, l?: number) => {
    const target = Math.max(0, Math.min(files.length - 1, f));
    pending.current = {f: target, ...(l !== undefined ? {l} : {})};
    currentRef.current = target;
    setCurrent(target);
    const line = l === undefined ? undefined : files[target]?.lines[l];
    setCursor(l === undefined ? null : {f: target, l});
    if (line) viewer.current?.scrollTo({type: 'line', id: idOf(target), lineNumber: line.k === DEL ? line.o : line.n, side: line.k === DEL ? 'deletions' : 'additions', align: 'center'});
    else viewer.current?.scrollTo({type: 'item', id: idOf(target), align: 'start'});
    if (!viewer.current) {
      if (l === undefined) plain.current?.toFile(target);
      else plain.current?.toLine(target, l);
    }
  }, [files]);
  useImperativeHandle(ref, () => ({toFile: jump, toLine: jump, current: () => cursor?.f ?? currentRef.current, focus: () => {
    if (viewer.current) host.current?.focus({preventScroll: true});
    else plain.current?.focus();
  }}), [jump, cursor]);
  useEffect(() => {onFile?.(current);}, [current, onFile]);
  useShortcutScope('diff');
  useShortcut('diff.nextFile', () => {jump((cursor?.f ?? currentRef.current) + 1);}, !!metadata && !failed);
  useShortcut('diff.prevFile', () => {jump((cursor?.f ?? currentRef.current) - 1);}, !!metadata && !failed);
  const comment = (f: number, l: number, range = false) => {
    if (l >= 0 && (extras?.commentable?.(f, l) ?? true)) extras?.onComment?.(f, l, range);
  };
  // The callback forwards this ref to the fallback component; it does not read it.
  // eslint-disable-next-line react-hooks/refs
  const fallbackView = fallback(plain);
  if (failed || !metadata) return fallbackView;
  const cursorFile = cursor ? files[cursor.f] : undefined;
  const cursorLine = cursor ? cursorFile?.lines[cursor.l] : undefined;
  return <WorkerReady fallback={fallbackView}>
    <div ref={host} role="list" aria-label="Changes" tabIndex={0} aria-activedescendant={cursor ? cursorId : undefined} className="outline-focus" onKeyDown={(event) => {
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
        if (line) viewer.current?.setSelectedLines({id: idOf(target), range: {start: line.k === DEL ? line.o : line.n, end: line.k === DEL ? line.o : line.n, side: line.k === DEL ? 'deletions' : 'additions'}});
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
      <CodeView ref={viewer} items={versioned} className="h-view overflow-auto" options={{
        theme: githubTheme, themeType: resolvedColorScheme === 'dark' ? 'dark' : 'light', unsafeCSS: primerCodeCSS,
        diffStyle: split ? 'split' : 'unified', stickyHeaders: true, enableLineSelection: true, enableGutterUtility: !!extras?.onComment,
        tokenizeMaxLineLength: 400, tokenizeMaxLength: 500_000, expansionLineCount: 40,
        loadDiffFiles: async (diff) => {
          const f = files.findIndex((file) => filePath(file) === diff.name);
          const file = files[f];
          if (!file) throw new Error('File unavailable');
          const [old, next] = await Promise.all([file.status === 'added' ? null : source.raw(repoId, base, file.oldPath), file.status === 'deleted' ? null : source.raw(repoId, head, file.newPath)]);
          if ((old && old.kind !== 'text') || (next && next.kind !== 'text')) throw new Error('File is not text');
          return {oldFile: {name: file.oldPath, contents: old?.kind === 'text' ? old.text : ''}, newFile: {name: file.newPath, contents: next?.kind === 'text' ? next.text : ''}};
        },
        onLineClick: (line, context) => {
          const f = Number(context.item.id.split(':')[1]);
          const l = lineIndex(f, line.lineNumber, 'side' in line && line.side === 'deletions' ? 'deletions' : 'additions');
          setCursor({f, l});
          host.current?.focus({preventScroll: true});
        },
        onPostRender: () => {if (pending.current) {const target = pending.current; pending.current = null; jump(target.f, target.l); pending.current = null;}},
      }} onScroll={(top, instance) => {
        const visible = instance.getRenderedItems();
        const first = visible.find((item) => (instance.getTopForItem(item.id) ?? 0) + item.element.offsetHeight > top);
        if (first) {const f = Number(first.id.split(':')[1]); currentRef.current = f; setCurrent(f);}
      }} renderCustomHeader={(item) => {
        const f = Number(item.id.split(':')[1]);
        const file = files[f];
        if (!file) return null;
        const collapsed = extras?.collapsed.has(f) ?? false;
        return <>
          <CodeFileHeader path={filePath(file)} {...(file.status === 'renamed' ? {oldPath: file.oldPath} : {})} stat={<DiffStat additions={file.additions} deletions={file.deletions}/>}
            leading={extras ? <IconButton icon={collapsed ? ChevronRightIcon : ChevronDownIcon} variant="invisible" size="small" aria-label={collapsed ? 'Expand the file' : 'Collapse the file'} aria-expanded={!collapsed} onClick={() => {extras.onToggle(f);}}/> : null}>{extras?.fileActions(f)}</CodeFileHeader>
        </>;
      }} renderAnnotation={(annotation) => {
        const {f, l, notes, image, empty} = annotation.metadata;
        if (image && files[f]) return <ImageDiff repoId={repoId} base={base} head={head} file={files[f]}/>;
        if (empty) return <p className="px-4 py-2 text-muted">{empty}</p>;
        return <div className="py-2 text-base text-default">{notes ? extras?.notesOf(f) : extras?.thread(f, l)}</div>;
      }}
      renderGutterUtility={(getHoveredLine, item) => <CommentButton getLine={getHoveredLine} onComment={(range) => {
        const line = getHoveredLine();
        if (!line) return;
        const f = Number(item.id.split(':')[1]);
        const selection = viewer.current?.getSelectedLines();
        const side = 'side' in line && line.side === 'deletions' ? 'deletions' : 'additions';
        if (selection?.id === item.id && selection.range.start !== selection.range.end && (!selection.range.endSide || selection.range.endSide === selection.range.side)) {
          const start = lineIndex(f, Math.min(selection.range.start, selection.range.end), side);
          const end = lineIndex(f, Math.max(selection.range.start, selection.range.end), side);
          if (start >= 0 && end >= 0) {comment(f, start); comment(f, end, true); return;}
        }
        comment(f, lineIndex(f, line.lineNumber, side), range);
      }}/>}/>
    </div>
  </WorkerReady>;
}
