// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, type Ref, useImperativeHandle} from 'react';
import {act, render} from '@testing-library/react';
import {beforeEach, expect, test, vi} from 'vitest';
import type {CodeViewLineSelection, SelectedLineRange} from '@pierre/diffs';
import type {CodeViewHandle, CodeViewProps} from '@pierre/diffs/react';
import {FileSurface, type LineRange} from './FileSurface.tsx';

type ViewerProps = CodeViewProps<undefined, undefined> & {ref?: Ref<CodeViewHandle<undefined, undefined>>};
let lastProps: ViewerProps | undefined;
let shown: CodeViewLineSelection | null = null;

vi.mock('../features/code/Lines.tsx', () => ({useViewSize: () => undefined}));
vi.mock('./PierreProvider.tsx', () => ({
  renderOptions: {},
  fileContents: (sha: string, name: string, contents: string) => ({name, contents, cacheKey: `${sha}:${name}`}),
  PierreProvider: ({children}: {children: (plain: boolean) => ReactNode}) => children(false),
}));
vi.mock('@pierre/diffs/react', async (original) => ({
  useStableCallback: (await original<{useStableCallback: unknown}>()).useStableCallback,
  CodeView: (props: ViewerProps) => {
    lastProps = props;
    useImperativeHandle(props.ref, () => ({setSelectedLines: (s: CodeViewLineSelection | null) => {shown = s;}, scrollTo: () => undefined}) as unknown as CodeViewHandle<undefined, undefined>);
    return null;
  },
}));

beforeEach(() => {shown = null;});

function surface(range: LineRange | undefined, onSelect: (r: LineRange) => void) {
  return <FileSurface name="a.go" text={'a\nb\nc\nd\n'} sha="s" lines={4} scroller={null} range={range} onSelect={onSelect}/>;
}

const options = () => lastProps?.options as {onLineSelected: (r: SelectedLineRange | null) => void; onPostRender: (node: HTMLElement) => void};

test('the view owns the selection while it is dragged; the URL follows only once it is committed', () => {
  const onSelect = vi.fn();
  const {rerender} = render(surface([1, 1], onSelect));
  expect(lastProps?.selectedLines).toBeUndefined();
  expect(lastProps?.onSelectedLinesChange).toBeUndefined();
  expect(shown).toEqual({id: 's:a.go', range: {start: 2, end: 2}});
  act(() => {options().onLineSelected({start: 4, end: 2});});
  expect(onSelect).toHaveBeenLastCalledWith([1, 3]);
  rerender(surface([1, 3], onSelect));
  expect(shown).toEqual({id: 's:a.go', range: {start: 2, end: 4}});
  // Unselecting the linked line by clicking it again keeps it linked.
  shown = null;
  act(() => {options().onLineSelected(null);});
  expect(shown).toEqual({id: 's:a.go', range: {start: 2, end: 4}});
  expect(onSelect).toHaveBeenCalledTimes(1);
});

test('line numbers are keyboard links: Enter links a line, Shift+Enter extends the linked range', () => {
  const onSelect = vi.fn();
  render(surface([1, 1], onSelect));
  const host = document.createElement('div');
  const root = host.attachShadow({mode: 'open'});
  for (const n of [2, 4]) {
    const number = document.createElement('div');
    number.setAttribute('data-column-number', String(n));
    root.append(number);
  }
  options().onPostRender(host);
  const [two, four] = root.querySelectorAll<HTMLElement>('[role=link]');
  expect(four?.getAttribute('aria-label')).toBe('Line 4');
  expect(four?.tabIndex).toBe(0);
  four?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true}));
  expect(onSelect).toHaveBeenLastCalledWith([1, 3]);
  four?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
  expect(onSelect).toHaveBeenLastCalledWith([3, 3]);
  two?.dispatchEvent(new KeyboardEvent('keydown', {key: ' '}));
  expect(onSelect).toHaveBeenCalledTimes(2);
});
