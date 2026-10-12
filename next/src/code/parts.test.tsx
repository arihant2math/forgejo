// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, expect, test} from 'vitest';
import {BlameCell, CodeFileHeader, CodeLine, CodeTokens, eachToken, LineAction} from './parts.tsx';

afterEach(cleanup);

test('code lines retain fixed geometry; hunk toolbars accommodate small Primer controls', () => {
  const {container} = render(<><CodeLine gutter={1}>source</CodeLine><CodeLine tone="hunk" gutter={null}>hunk</CodeLine></>);
  expect(container.children[0]?.classList.contains('h-line')).toBe(true);
  expect(container.children[1]?.classList.contains('h-8')).toBe(true);
  expect(container.children[1]?.classList.contains('items-center')).toBe(true);
});

test('file headers use the Primer box-header height and a semibold primary path', () => {
  render(<CodeFileHeader path="src/util.go"/>);
  const path = screen.getByTitle('src/util.go');
  expect(path.classList.contains('text-base')).toBe(true);
  expect(path.classList.contains('font-semibold')).toBe(true);
  expect(path.parentElement?.classList.contains('h-10')).toBe(true);
});

test('file headers reserve the basename and keep status as secondary metadata', () => {
  render(<CodeFileHeader path="contrib/nushell/fzf.nu" status="added"/>);
  const basename = screen.getByText('fzf.nu');
  expect(basename.classList.contains('shrink-0')).toBe(true);
  expect(screen.getByText('contrib/nushell/').classList.contains('truncate')).toBe(true);
  expect(screen.getByTitle('contrib/nushell/fzf.nu').textContent).toBe('contrib/nushell/fzf.nu');
  expect(screen.getByText('added').classList.contains('text-sm')).toBe(true);
  expect(screen.getByText('added').classList.contains('text-muted')).toBe(true);
});

test('blame keeps primary commit text distinct from muted timestamp metadata', () => {
  render(<BlameCell first summary="Fix the index" meta="1h"/>);
  expect(screen.getByText('1h').classList.contains('text-sm')).toBe(true);
  expect(screen.getByText('Fix the index').parentElement?.classList.contains('text-base')).toBe(true);
});

test('line actions retain their accessible name and explicit keyboard tab stop', () => {
  render(<LineAction label="Line actions" tabIndex={0}>…</LineAction>);
  expect(screen.getByRole('button', {name: 'Line actions'}).tabIndex).toBe(0);
});

// "const x = 1": keyword, plain, a constant (class codes are SYNTAX indexes; 1 = keyword, 6 = constant).
const HL = {spans: Uint32Array.of(5, 1, 5, 0, 1, 6), starts: Uint32Array.of(0, 3)};

test('tokens: ranges with their classes; text past the spans, or without highlighting, is one plain token', () => {
  const seen: [number, number, string][] = [];
  eachToken(HL, 0, 13, (from, to, cls) => seen.push([from, to, cls]));
  expect(seen).toEqual([[0, 5, 'text-syntax-keyword'], [5, 10, ''], [10, 11, 'text-syntax-constant'], [11, 13, '']]);
  const plain: [number, number, string][] = [];
  eachToken(null, 0, 3, (from, to, cls) => plain.push([from, to, cls]));
  expect(plain).toEqual([[0, 3, '']]);
});

test('search matches are marked over the syntax colours, split at token edges', () => {
  const {container} = render(<div><CodeTokens text="const x = 1" hl={HL} line={0} marks={[{from: 3, to: 7}]}/></div>);
  const marks = [...container.querySelectorAll('mark')];
  expect(marks.map((m) => m.textContent)).toEqual(['st', ' x']);
  expect(marks[0]?.querySelector('.text-syntax-keyword')?.textContent).toBe('st');
  expect(container.textContent).toBe('const x = 1');
  const {container: plain} = render(<div><CodeTokens text="abc" line={0} marks={[{from: 1, to: 2}]}/></div>);
  expect(plain.querySelector('mark')?.textContent).toBe('b');
});
