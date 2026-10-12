// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, type Ref, useCallback, useImperativeHandle, useRef} from 'react';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import type {CodeViewLineSelection} from '@pierre/diffs';
import type {CodeViewHandle, ControlledCodeViewProps} from '@pierre/diffs/react';
import type {DiffExtras} from '../features/code/DiffView.tsx';
import {parseDiff} from './diff.ts';
import {ReviewSurface} from './ReviewSurface.tsx';

interface Annotation {f: number; l: number; notes?: boolean; image?: boolean; empty?: string}
type ViewerProps = ControlledCodeViewProps<Annotation, undefined> & {ref?: Ref<CodeViewHandle<Annotation, undefined>>};
let lastProps: ViewerProps | undefined;
let selected: CodeViewLineSelection | null = null;
let plain = false;
const raw = vi.fn(() => Promise.resolve({kind: 'text' as const, text: 'one\nTWO\nthree\nfour\n'}));

vi.mock('../features/code/hooks.ts', () => ({useSource: () => ({raw})}));
vi.mock('../features/code/DiffSettings.tsx', () => ({useDiffSettings: () => ({split: false, whitespace: ''})}));
vi.mock('../app/shortcuts/index.ts', () => ({useShortcut: () => undefined, useShortcutScope: () => undefined}));
vi.mock('./PierreProvider.tsx', () => ({
  renderOptions: {},
  PierreProvider: ({children}: {children: (plain: boolean) => ReactNode}) => children(plain),
}));
// Test the viewer contract with the real parser, without browser layout or Shadow DOM.
vi.mock('@pierre/diffs/react', () => ({
  useStableCallback: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const latest = useRef(fn);
    latest.current = fn;
    return useCallback((...args: A) => latest.current(...args), []);
  },
  CodeView: (props: ViewerProps) => {
    lastProps = props;
    useImperativeHandle(props.ref, (): CodeViewHandle<Annotation, undefined> => ({
      scrollTo: () => undefined, getSelectedLines: () => selected, setSelectedLines: (selection) => {selected = selection;},
      clearSelectedLines: () => {selected = null;},
      getItem: (id) => props.items.find((item) => item.id === id),
      addItems: () => {throw new Error('Unexpected addItems');},
      removeItem: () => {throw new Error('Unexpected removeItem');},
      updateItem: () => {throw new Error('Unexpected updateItem');},
      updateItemId: () => {throw new Error('Unexpected updateItemId');},
      getEditor: () => {throw new Error('Unexpected getEditor');},
      getInstance: () => {throw new Error('Unexpected getInstance');},
    }));
    return <div>{props.items.map((item) => <div key={item.id}>
      {props.renderCustomHeader?.(item)}
      {item.annotations?.map((annotation, index) => <div key={index}>{props.renderAnnotation?.(annotation, item)}</div>)}
      {props.renderGutterUtility?.(() => ({lineNumber: 3, side: 'additions' as const}), item)}
      <button onClick={() => {props.options?.onLineClick?.({lineNumber: 1, annotationSide: 'deletions'} as never, {item} as never);}}>Old context line {item.id}</button>
    </div>)}</div>;
  },
}));

const files = parseDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three\n four\n' +
  'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b\n+B\n');
function extras(): DiffExtras {
  return {threads: new Set(['0:1', '0:3']), notes: new Set([0]), collapsed: new Set(),
    thread: (_f, l) => <p>Thread {l}</p>, notesOf: () => <p>Outdated thread</p>,
    onComment: vi.fn(), fileActions: () => null, onToggle: vi.fn()};
}
const props = {repoId: 20, base: 'base', head: 'head', files, scroller: null};

beforeEach(() => {selected = null; lastProps = undefined; plain = false; raw.mockClear();});
afterEach(() => {cleanup();});

function viewer() {
  if (!lastProps) throw new Error('no viewer');
  return lastProps;
}

test('old/new conversations and outdated notes become correctly positioned React annotations', () => {
  render(<ReviewSurface {...props} extras={extras()}/>);
  expect(viewer().items[0]?.annotations).toEqual([
    {side: 'additions', lineNumber: 0, metadata: {f: 0, l: -1, notes: true}},
    {side: 'deletions', lineNumber: 2, metadata: {f: 0, l: 1}},
    {side: 'additions', lineNumber: 3, metadata: {f: 0, l: 3}},
  ]);
  expect(screen.getByText('Outdated thread')).toBeTruthy();
});

test('a change to one file\'s threads re-renders only that file; new thread content needs no new item', () => {
  const x = extras();
  const {rerender} = render(<ReviewSurface {...props} extras={x}/>);
  const versions = () => viewer().items.map((item) => item.version);
  const [first, second] = versions();
  const options = viewer().options;
  rerender(<ReviewSurface {...props} extras={{...x, thread: (_f, l) => <p>Updated thread {l}</p>}}/>);
  expect(screen.getByText('Updated thread 3')).toBeTruthy();
  expect(versions()).toEqual([first, second]);
  rerender(<ReviewSurface {...props} extras={{...x, threads: new Set([...x.threads, '1:0'])}}/>);
  expect(versions()[0]).toBe(first);
  expect(versions()[1]).not.toBe(second);
  expect(viewer().items[1]?.annotations).toEqual([{side: 'deletions', lineNumber: 1, metadata: {f: 1, l: 0}}]);
  expect(viewer().options).toBe(options);
});

test('a clicked line becomes the cursor and the selection (which carries the comment button); the viewer options stay', () => {
  render(<ReviewSurface {...props} extras={extras()}/>);
  const options = viewer().options;
  fireEvent.click(screen.getByRole('button', {name: 'Old context line file:0'}));
  expect(screen.getByRole('status').textContent).toMatch(/, line 1: /);
  expect(selected).toEqual({id: 'file:0', range: {start: 1, end: 1, side: 'deletions'}});
  expect(viewer().options).toBe(options);
});

test('selected ranges open the existing composer at both endpoints; old context supports Enter comments', () => {
  const x = extras();
  render(<ReviewSurface {...props} extras={x}/>);
  selected = {id: 'file:0', range: {start: 2, end: 3, side: 'additions'}};
  const [plus] = screen.getAllByRole('button', {name: 'Comment on line 3'});
  if (!plus) throw new Error('no comment button');
  fireEvent.click(plus);
  expect(x.onComment).toHaveBeenNthCalledWith(1, 0, 2, false);
  expect(x.onComment).toHaveBeenNthCalledWith(2, 0, 3, true);
  fireEvent.click(screen.getByRole('button', {name: 'Old context line file:0'}));
  fireEvent.keyDown(screen.getByRole('region', {name: 'Changes'}), {key: 'Enter'});
  expect(x.onComment).toHaveBeenLastCalledWith(0, 0, false);
});

test('expanding partial patches reads immutable base/head bodies through the offline code source', async () => {
  render(<ReviewSurface {...props} extras={extras()}/>);
  const item = viewer().items[0];
  if (item?.type !== 'diff') throw new Error('no diff');
  expect(item.fileDiff.cacheKey).toBe('20:base:head::0');
  const result = await viewer().options?.loadDiffFiles?.(item.fileDiff);
  expect(raw).toHaveBeenNthCalledWith(1, 20, 'base', 'a.txt');
  expect(raw).toHaveBeenNthCalledWith(2, 20, 'head', 'a.txt');
  expect(result?.newFile.contents).toContain('three');
});

test('without working highlight workers the diff renders as plain text', () => {
  plain = true;
  render(<ReviewSurface {...props}/>);
  const item = viewer().items[0];
  expect(item?.type === 'diff' ? item.fileDiff.lang : undefined).toBe('text');
});
