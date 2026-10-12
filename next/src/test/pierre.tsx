// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A light-DOM stand-in for @pierre/diffs/react in jsdom (no layout, workers or Shadow DOM). It renders each line as a
// listitem (number, `.code-text`, the gutter utility), annotations after their line, headers first, and calls the
// same callbacks CodeView does. `pierreFake` records what views asked of it.

import type {CodeViewItem, CodeViewLineSelection, CodeViewScrollTarget, DiffLineAnnotation, FileDiffMetadata, SelectionSide} from '@pierre/diffs';
import type {CodeViewHandle, ControlledCodeViewProps} from '@pierre/diffs/react';
import {createContext, type ReactNode, type Ref, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState} from 'react';

export const pierreFake = {scrolls: [] as CodeViewScrollTarget[]};

export const WorkerPoolContext = createContext<unknown>(undefined);

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {latest.current = fn;});
  return useCallback((...args: A) => latest.current(...args), []);
}

interface Line {side: SelectionSide; old: number; new: number; text: string; type: string}

function diffLines(diff: FileDiffMetadata): Line[] {
  const lines: Line[] = [];
  for (const hunk of diff.hunks) {
    let old = hunk.deletionStart;
    let next = hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        for (let i = 0; i < part.lines; i++) lines.push({side: 'additions', old: old++, new: next++, text: diff.additionLines[part.additionLineIndex + i] ?? '', type: 'context'});
      } else {
        for (let i = 0; i < part.deletions; i++) lines.push({side: 'deletions', old: old++, new: 0, text: diff.deletionLines[part.deletionLineIndex + i] ?? '', type: 'change-deletion'});
        for (let i = 0; i < part.additions; i++) lines.push({side: 'additions', old: 0, new: next++, text: diff.additionLines[part.additionLineIndex + i] ?? '', type: 'change-addition'});
      }
    }
  }
  return lines;
}

type Props<A> = ControlledCodeViewProps<A, undefined> & {ref?: Ref<CodeViewHandle<A, undefined>>};

export function CodeView<A>(props: Props<A>) {
  const {ref, items, options, selectedLines, onSelectedLinesChange, renderAnnotation, renderCustomHeader, renderGutterUtility, className} = props;
  const [own, setOwn] = useState<CodeViewLineSelection | null>(null);
  const shown = selectedLines === undefined ? own : selectedLines;
  useImperativeHandle(ref, (): CodeViewHandle<A, undefined> => ({
    scrollTo: (target) => {pierreFake.scrolls.push(target);},
    getSelectedLines: () => shown,
    setSelectedLines: (next) => {setOwn(next); onSelectedLinesChange?.(next);},
    clearSelectedLines: () => {setOwn(null);},
    getItem: (id) => items.find((item) => item.id === id),
    addItems: () => undefined, removeItem: () => false, updateItem: () => false, updateItemId: () => false,
    getEditor: () => undefined, getInstance: () => undefined,
  }));
  const gutter = options?.enableGutterUtility === true && renderGutterUtility;
  const row = (item: CodeViewItem<A>, key: string, side: SelectionSide, number: number, numbers: ReactNode, text: string, type: string, after: ReactNode) => {
    const picked = shown?.id === item.id && number >= shown.range.start && number <= shown.range.end;
    return <div key={key}>
      <div role="listitem" data-line-type={type} data-selected={picked ? '' : undefined}
        onClick={() => {(options?.onLineClick as ((line: unknown, context: unknown) => void) | undefined)?.({lineNumber: number, annotationSide: side}, {item});}}>
        {numbers}<span className="code-text">{text.replace(/\r?\n$/, '')}</span>
        {gutter && gutter(() => ({lineNumber: number, side}) as never, item)}
      </div>
      {after}
    </div>;
  };
  const annotationsAt = (item: CodeViewItem<A>, side: SelectionSide | undefined, n: number) => (item.annotations ?? [])
    .filter((a) => a.lineNumber === n && (side === undefined || (a as DiffLineAnnotation<A>).side === side))
    .map((a, i) => <div key={`a${String(i)}`} role="listitem">{renderAnnotation?.(a, item)}</div>);
  return <div className={className}>
    {items.map((item) => <div key={item.id} data-item={item.id}>
      {renderCustomHeader?.(item)}
      {item.type === 'diff' ? <>
        {annotationsAt(item, undefined, 0)}
        {!item.collapsed && diffLines(item.fileDiff).map((line, i) => row(item, String(i), line.side, line.side === 'deletions' ? line.old : line.new,
          <><span>{line.old || ''}</span><span>{line.new || ''}</span></>, line.text, line.type, annotationsAt(item, line.side, line.side === 'deletions' ? line.old : line.new)))}
      </> : item.file.contents.split('\n').slice(0, item.file.contents.endsWith('\n') ? -1 : undefined).map((text, i) => row(item, String(i), 'additions', i + 1,
        <button type="button" aria-label={`Line ${String(i + 1)}`} onClick={() => {onSelectedLinesChange?.({id: item.id, range: {start: i + 1, end: i + 1}});}}>{i + 1}</button>,
        text, 'context', annotationsAt(item, undefined, i + 1)))}
    </div>)}
  </div>;
}
