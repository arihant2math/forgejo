// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// CommandPick's listbox (QA #179): applied options are the selected ones; the keyboard cursor is only the
// combobox's aria-activedescendant and data-highlighted. The keys are cmdk's.

import {fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {CommandPick, type PickOption} from './Command.tsx';

const scrolled: Element[] = [];
beforeEach(() => {
  scrolled.length = 0;
  // jsdom does not scroll; record what the list brings into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

function labels(onSelect = vi.fn()): PickOption[] {
  return [
    {value: 'l1', label: 'awaiting-triage', checked: false, keepOpen: true, onSelect},
    {value: 'l2', label: 'bug', checked: true, keepOpen: true, onSelect},
    {value: 'l3', label: 'docs', checked: 'mixed', keepOpen: true, onSelect},
    {value: 'l4', label: 'security', checked: false, keepOpen: true, onSelect},
  ];
}

const combobox = () => screen.getByRole('combobox');
const option = (name: string) => screen.getByRole('option', {name: new RegExp(`^${name}`)});
const cursor = () => {
  const id = combobox().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : undefined;
};
const highlighted = () => [...document.querySelectorAll('[role=option][data-highlighted]')].map((o) => o.textContent);

test('a multi-value picker: applied options are aria-selected, the cursor is not (#179)', () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<CommandPick label="Change labels" placeholder="Add labels…" empty="No labels" onClose={onClose} options={labels(onSelect)}/>);
  const list = screen.getByRole('listbox', {name: 'Change labels'});
  expect(list.getAttribute('aria-multiselectable')).toBe('true');
  expect(combobox().getAttribute('aria-controls')).toBe(list.id);
  // Opens on its first option (the cursor), which is not applied: not selected.
  expect(cursor()).toBe('awaiting-triage');
  expect(highlighted()).toEqual(['awaiting-triage']);
  expect(option('awaiting-triage').getAttribute('aria-selected')).toBe('false');
  // Only what is applied is selected; some of several issues is not, and says so.
  expect(screen.getAllByRole('option', {selected: true}).map((o) => o.textContent)).toEqual(['bug']);
  expect(option('docs').getAttribute('aria-selected')).toBe('false');
  expect(within(option('docs')).getByText('(on some)').className).toContain('sr-only');
  // Moving the cursor changes the active descendant and the highlight only.
  fireEvent.keyDown(combobox(), {key: 'ArrowDown'});
  expect(cursor()).toBe('bug');
  fireEvent.keyDown(combobox(), {key: 'ArrowDown'});
  expect(cursor()).toBe('docs (on some)');
  expect(screen.getAllByRole('option', {selected: true}).map((o) => o.textContent)).toEqual(['bug']);
  // Enter applies the cursor's option and stays open for more.
  fireEvent.keyDown(combobox(), {key: 'Enter'});
  expect(onSelect).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

test('a one-value picker opens on its value, which is selected; Enter keeps it and closes', () => {
  const pick = vi.fn();
  const onClose = vi.fn();
  render(<CommandPick label="Set milestone" placeholder="Move to…" empty="None" onClose={onClose} options={[
    {value: 'none', label: 'No milestone', checked: false, onSelect: vi.fn()},
    {value: 'm1', label: 'Cycle 14', checked: false, onSelect: vi.fn()},
    {value: 'm2', label: 'Cycle 15', checked: true, onSelect: pick},
  ]}/>);
  expect(screen.getByRole('listbox').hasAttribute('aria-multiselectable')).toBe(false);
  expect(cursor()).toBe('Cycle 15');
  expect(option('Cycle 15').getAttribute('aria-selected')).toBe('true');
  // Opening brings the current value into view.
  expect(scrolled).toContain(option('Cycle 15'));
  fireEvent.keyDown(combobox(), {key: 'Enter'});
  expect(pick).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test('keys: arrows loop, Home/End, ⌘ to the ends, Alt to the next group; each move scrolls into view', () => {
  render(<CommandPick label="Filter" placeholder="Filter by…" empty="Nothing" onClose={vi.fn()} options={[
    {value: 'a', label: 'alice', group: 'Assignee', onSelect: vi.fn()},
    {value: 'b', label: 'bob', group: 'Assignee', onSelect: vi.fn()},
    {value: 'l', label: 'bug', group: 'Labels', onSelect: vi.fn()},
    {value: 'm', label: 'v1', group: 'Milestone', onSelect: vi.fn()},
  ]}/>);
  const key = (k: string, init: KeyboardEventInit = {}) => {
    fireEvent.keyDown(combobox(), {key: k, ...init});
    return cursor();
  };
  expect(cursor()).toBe('alice');
  expect(key('ArrowUp')).toBe('v1');
  expect(key('ArrowDown')).toBe('alice');
  expect(key('End')).toBe('v1');
  expect(key('Home')).toBe('alice');
  expect(key('ArrowDown', {metaKey: true})).toBe('v1');
  expect(key('ArrowUp', {metaKey: true})).toBe('alice');
  expect(key('ArrowDown', {altKey: true})).toBe('bug');
  expect(key('ArrowDown', {altKey: true})).toBe('v1');
  expect(key('ArrowUp', {altKey: true})).toBe('bug');
  // The cursor's row is brought into view; a group's first row brings its heading too.
  expect(scrolled.at(-1)).toBe(option('bug'));
  expect(scrolled.at(-2)?.textContent).toBe('Labels');
  // Groups are labelled by their headings; actions (no check slot) are not selectable choices.
  expect(screen.getByRole('group', {name: 'Labels'})).toBeTruthy();
  expect(option('bug').hasAttribute('aria-selected')).toBe(false);
  // The pointer moves the cursor; a click chooses.
  fireEvent.pointerMove(option('bob'));
  expect(cursor()).toBe('bob');
});

test('typing narrows and puts the cursor on the first match; empty states', () => {
  const {rerender} = render(<CommandPick label="Change labels" placeholder="Add labels…" empty="This repository has no labels." onClose={vi.fn()} options={labels()}/>);
  fireEvent.keyDown(combobox(), {key: 'End'});
  fireEvent.change(combobox(), {target: {value: 'u'}});
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['bug', 'security']);
  expect(cursor()).toBe('bug');
  fireEvent.change(combobox(), {target: {value: 'zzz'}});
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  expect(screen.getByText('Nothing matches.')).toBeTruthy();
  expect(combobox().hasAttribute('aria-activedescendant')).toBe(false);
  // Enter on nothing does nothing.
  fireEvent.keyDown(combobox(), {key: 'Enter'});
  rerender(<CommandPick label="Change labels" placeholder="Add labels…" empty="This repository has no labels." onClose={vi.fn()} options={[]}/>);
  expect(screen.getByText('This repository has no labels.')).toBeTruthy();
});

test('a click chooses without taking the focus from the field', () => {
  const pick = vi.fn();
  render(<CommandPick label="Change labels" placeholder="Add labels…" empty="No labels" onClose={vi.fn()} options={labels(pick)}/>);
  combobox().focus();
  const down = fireEvent.mouseDown(option('security'));
  expect(down).toBe(false); // default prevented: the field keeps the focus
  fireEvent.click(option('security'));
  expect(pick).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(combobox());
});
