// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, type Ref, useImperativeHandle} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {parsePatchFiles, type CodeViewLineSelection} from '@pierre/diffs';
import type {CodeViewHandle, ControlledCodeViewProps} from '@pierre/diffs/react';
import type {DiffExtras} from '../features/code/DiffView.tsx';
import {parseDiff, type DiffFile} from './diff.ts';
import {pierrePatch} from './pierrePatch.ts';
import {ReviewSurface} from './ReviewSurface.tsx';

interface Annotation {f: number; l: number; notes?: boolean; image?: boolean; empty?: string}
type ViewerProps = ControlledCodeViewProps<Annotation, undefined> & {ref?: Ref<CodeViewHandle<Annotation, undefined>>};
let lastProps: ViewerProps | undefined;
let selected: CodeViewLineSelection | null = null;
const raw = vi.fn(() => Promise.resolve({kind: 'text' as const, text: 'one\nTWO\nthree\nfour\n'}));

vi.mock('../features/code/hooks.ts', () => ({useSource: () => ({raw})}));
vi.mock('../features/code/DiffSettings.tsx', () => ({useDiffSettings: () => ({split: false, whitespace: ''})}));
vi.mock('../app/shortcuts/index.ts', () => ({useShortcut: () => undefined, useShortcutScope: () => undefined}));
vi.mock('./PierreProvider.tsx', () => ({
  githubTheme: {light: 'github-light', dark: 'github-dark'}, primerCodeCSS: '',
  PierreProvider: ({children}: {children: ReactNode}) => children,
  WorkerReady: ({children}: {children: ReactNode}) => children,
}));
// Test the feature/library contract independently of browser layout and Shadow DOM.
// The actual parser is used by the fake worker; highlighting and virtualization belong to Pierre.
vi.mock('@pierre/diffs/react', () => ({CodeView: (props: ViewerProps) => {
  lastProps = props;
  useImperativeHandle(props.ref, (): CodeViewHandle<Annotation, undefined> => ({
    scrollTo: () => undefined, getSelectedLines: () => selected, setSelectedLines: (selection) => {selected = selection;},
    clearSelectedLines: () => {selected = null;},
    getItem: (id) => props.items.find((item) => item.id === id),
    // These tests use the controlled viewer; mutations and editor access are unexpected.
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
    <button onClick={() => {props.options?.onLineClick?.({lineNumber: 1, side: 'deletions'} as never, {item} as never);}}>Old context line</button>
  </div>)}</div>;
}}));

class ParserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private stopped = false;
  postMessage(files: readonly DiffFile[]) {
    void Promise.resolve().then(() => {
      if (this.stopped) return;
      this.onmessage?.({data: {files: files.map((file) => parsePatchFiles(pierrePatch(file))[0]?.files[0])}} as MessageEvent);
    });
  }
  terminate() {this.stopped = true;}
}

const files = parseDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three\n four\n');
function extras(): DiffExtras {
  return {threads: new Set(['0:1', '0:3']), notes: new Set([0]), collapsed: new Set(),
    thread: (_f, l) => <p>Thread {l}</p>, notesOf: () => <p>Outdated thread</p>,
    onComment: vi.fn(), fileActions: () => null, onToggle: vi.fn()};
}
const props = {repoId: 20, base: 'base', head: 'head', files, scroller: null, fallback: () => <p>Plain fallback</p>};

beforeEach(() => {
  vi.stubGlobal('Worker', ParserWorker); selected = null; lastProps = undefined; raw.mockClear();
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

async function ready() {
  await waitFor(() => {expect(lastProps?.items.length).toBe(1);});
  if (!lastProps) throw new Error('no viewer');
  return lastProps;
}

test('old/new conversations and outdated notes become correctly positioned React annotations', async () => {
  const x = extras();
  const {rerender} = render(<ReviewSurface {...props} extras={x}/>);
  const first = await ready();
  const item = first.items[0];
  expect(item?.annotations).toEqual([
    {side: 'additions', lineNumber: 0, metadata: {f: 0, l: -1, notes: true}},
    {side: 'deletions', lineNumber: 2, metadata: {f: 0, l: 1}},
    {side: 'additions', lineNumber: 3, metadata: {f: 0, l: 3}},
  ]);
  expect(screen.getByText('Outdated thread')).toBeTruthy();
  rerender(<ReviewSurface {...props} extras={{...x, thread: (_f, l) => <p>Updated thread {l}</p>}}/>);
  expect(await screen.findByText('Updated thread 3')).toBeTruthy();
  expect(lastProps?.items[0]?.version).toBeGreaterThan(item?.version ?? 0);
});

test('selected ranges open the existing composer at both endpoints; old context supports Enter comments', async () => {
  const x = extras();
  render(<ReviewSurface {...props} extras={x}/>);
  await ready();
  selected = {id: 'file:0', range: {start: 2, end: 3, side: 'additions'}};
  const plus = screen.getByRole('button', {name: 'Comment on line'});
  fireEvent.pointerEnter(plus);
  expect(screen.getByRole('button', {name: 'Comment on line 3'})).toBe(plus);
  fireEvent.click(plus);
  expect(x.onComment).toHaveBeenNthCalledWith(1, 0, 2, false);
  expect(x.onComment).toHaveBeenNthCalledWith(2, 0, 3, true);
  fireEvent.click(screen.getByRole('button', {name: 'Old context line'}));
  fireEvent.keyDown(screen.getByRole('list', {name: 'Changes'}), {key: 'Enter'});
  expect(x.onComment).toHaveBeenLastCalledWith(0, 0, false);
});

test('expanding partial patches reads immutable base/head bodies through the offline code source', async () => {
  render(<ReviewSurface {...props} extras={extras()}/>);
  const view = await ready();
  const item = view.items[0];
  if (item?.type !== 'diff') throw new Error('no diff');
  expect(item.fileDiff.cacheKey).toBe('20:base:head::0');
  const result = await view.options?.loadDiffFiles?.(item.fileDiff);
  expect(raw).toHaveBeenNthCalledWith(1, 20, 'base', 'a.txt');
  expect(raw).toHaveBeenNthCalledWith(2, 20, 'head', 'a.txt');
  expect(result?.newFile.contents).toContain('three');
});
