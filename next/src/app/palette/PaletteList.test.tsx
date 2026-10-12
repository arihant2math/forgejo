// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {useRef, useState} from 'react';
import {expect, test, vi} from 'vitest';
import {PaletteList, type PaletteGroup} from './PaletteList.tsx';

const input = () => screen.getByRole('combobox', {name: 'Command menu'});
const cursor = () => {
  const id = input().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};
function setup(groups: PaletteGroup[], initial = groups[0]?.rows[0]?.value ?? '') {
  const choose = vi.fn();
  function Harness() {
    const inputRef = useRef<HTMLInputElement>(null);
    const [selected, setSelected] = useState(initial);
    const [query, setQuery] = useState('');
    return <PaletteList inputRef={inputRef} query={query} onQueryChange={setQuery} groups={groups}
      selected={selected} onSelectedChange={setSelected} onChoose={choose} empty={groups.length ? null : 'Nothing found on this device.'}/>;
  }
  render(<Harness/>);
  return choose;
}
const group = (heading: string, ...names: string[]): PaletteGroup => ({heading, rows: names.map((name) => ({value: name, label: name, run: vi.fn()}))});

test('active-descendant keys loop, go to the ends and jump between groups without moving input focus', () => {
  setup([group('People', 'Alice', 'Bob'), group('Repositories', 'Website'), group('Commands', 'Create')]);
  input().focus();
  expect(input().getAttribute('aria-controls')).toBe(screen.getByRole('listbox', {name: 'Command menu'}).id);
  expect(screen.getByRole('group', {name: 'People'})).toBeTruthy();
  const key = (key: string, init: KeyboardEventInit = {}) => {
    fireEvent.keyDown(input(), {key, ...init});
    expect(document.activeElement).toBe(input());
    return cursor()?.textContent;
  };
  expect(key('ArrowUp')).toBe('Create');
  expect(key('ArrowDown')).toBe('Alice');
  expect(key('End')).toBe('Create');
  expect(key('Home')).toBe('Alice');
  expect(key('ArrowDown', {metaKey: true})).toBe('Create');
  expect(key('ArrowUp', {metaKey: true})).toBe('Alice');
  expect(key('ArrowDown', {altKey: true})).toBe('Website');
  expect(key('ArrowUp', {altKey: true})).toBe('Alice');
  expect(screen.getAllByRole('option', {selected: true})).toEqual([cursor()]);
});

test('pointer cursor and click choose without taking focus; Enter chooses once', () => {
  const choose = setup([group('Commands', 'Inbox', 'Issues')]);
  input().focus();
  const issues = screen.getByRole('option', {name: 'Issues'});
  fireEvent.pointerMove(issues);
  expect(cursor()).toBe(issues);
  expect(fireEvent.mouseDown(issues)).toBe(false);
  fireEvent.click(issues);
  expect(document.activeElement).toBe(input());
  expect(choose).toHaveBeenCalledOnce();
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(choose).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(input(), {key: 'Enter', isComposing: true});
  expect(choose).toHaveBeenCalledTimes(2);
});

test('no default means Enter does nothing until an arrow moves the cursor; an empty list has no descendant', () => {
  const choose = setup([group('Commands', 'Sign out')], '');
  expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(input(), {key: 'ArrowDown'});
  expect(cursor()?.textContent).toBe('Sign out');
});

test('empty states stay readable and all keys are safe with no rows', () => {
  const choose = setup([]);
  expect(screen.getByRole('status').textContent).toBe('Nothing found on this device.');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) fireEvent.keyDown(input(), {key});
  expect(choose).not.toHaveBeenCalled();
  expect(input().hasAttribute('aria-activedescendant')).toBe(false);
});

test('large result sets virtualize groups while keeping an offscreen keyboard cursor mounted', () => {
  // jsdom has no layout; the virtualizer measures offsetHeight for its viewport.
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(384);
  try {
    setup(Array.from({length: 12}, (_, index) => group(`Group ${String(index)}`, ...Array.from({length: 8}, (_, item) => `Item ${String(index)}-${String(item)}`))));
    expect(screen.getAllByRole('option').length).toBeLessThan(96);
    fireEvent.keyDown(input(), {key: 'End'});
    expect(cursor()?.textContent).toBe('Item 11-7');
    expect(screen.getAllByRole('option', {selected: true})).toEqual([cursor()]);
  } finally {
    height.mockRestore();
  }
});
