// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, test, vi} from 'vitest';
import {
  Avatar, Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Dialog, DialogTrigger, IconButton,
  Input, LabelChip, LabelDot, LabelPill, ListRow, Menu, MenuContent, MenuItem, MenuTrigger, Shortcut, TooltipProvider,
} from './index.ts';
import {classConflicts} from '../test/conflicts.ts';
import {PlusIcon, TagIcon} from '@primer/octicons-react';

describe('primitives', () => {
  test('Button: type=button by default, variant and size classes, icon', () => {
    render(<Button variant="primary" size="sm" icon={PlusIcon}>New</Button>);
    const b = screen.getByRole('button', {name: 'New'});
    expect(b.getAttribute('type')).toBe('button');
    expect(b.className).toContain('bg-accent-emphasis');
    expect(b.className).toContain('h-control-sm');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('IconButton: accessible name from label', () => {
    render(<TooltipProvider><IconButton icon={PlusIcon} label="Create issue" shortcut="C"/></TooltipProvider>);
    expect(screen.getByRole('button', {name: 'Create issue'}).className).toContain('size-control');
  });

  test('Input: sized by className (it has no width of its own)', () => {
    render(<Input className="w-64" placeholder="w"/>);
    const el = screen.getByPlaceholderText('w');
    expect(el.className).toContain('w-64');
    expect(classConflicts(document.body)).toEqual([]);
  });

  test('menu items and contents take no className or style (the recipe is the whole look)', () => {
    const rejected = [
      // @ts-expect-error className is not a MenuItem prop
      <MenuItem key="a" className="w-full">x</MenuItem>,
      // @ts-expect-error style is not a MenuItem prop
      <MenuItem key="b" style={{}}>x</MenuItem>,
      // @ts-expect-error className is not a ListRow prop
      <ListRow key="c" role="option" className="p-1">x</ListRow>,
    ];
    expect(rejected).toHaveLength(3);
  });

  test('Input: invalid state', () => {
    render(<Input invalid placeholder="x"/>);
    expect(screen.getByPlaceholderText('x').getAttribute('aria-invalid')).toBe('true');
  });

  test('Shortcut: a sequence renders one key cap per key', () => {
    const {container} = render(<Shortcut keys="G I"/>);
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['G', 'I']);
  });

  test('Avatar: initial fallback, image when given', () => {
    render(<><Avatar name="ünal"/><Avatar name="bob" src="/a.png"/></>);
    expect(screen.getByRole('img', {name: 'ünal'}).textContent).toBe('Ü');
    expect(screen.getByRole('img', {name: 'bob'}).tagName).toBe('IMG');
  });

  test('LabelChip: label colour via a CSS variable', () => {
    const {container} = render(<LabelChip name="bug" color="var(--fgColor-danger)"/>);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--label-color')).toBe('var(--fgColor-danger)');
  });

  test('LabelPill and LabelDot: a fill always has an edge (a white label still shows as a pill)', () => {
    const {container} = render(<><LabelPill name="wontfix" color="#ffffff"/><LabelPill name="bug" color="#e11d21"/><LabelDot color="#fff"/></>);
    const fills = [...container.children] as HTMLElement[];
    expect(fills.map((el) => el.style.getPropertyValue('--label-color'))).toEqual(['#ffffff', '#e11d21', '#fff']);
    for (const el of fills) expect(el.className).toMatch(/\bbg-label edge-label\b/);
  });

  test('ListRow: selection is exposed as data-selected and aria-selected', () => {
    render(<ListRow selected role="option">Row</ListRow>);
    const row = screen.getByRole('option');
    expect(row.dataset.selected).toBe('');
    expect(row.getAttribute('aria-selected')).toBe('true');
  });

  test('Menu: opens from the keyboard, shows shortcuts, selects', () => {
    const onSelect = vi.fn();
    render(
      <Menu>
        <MenuTrigger asChild><Button>Open</Button></MenuTrigger>
        <MenuContent>
          <MenuItem icon={TagIcon} shortcut="L" onSelect={onSelect}>Labels</MenuItem>
        </MenuContent>
      </Menu>,
    );
    fireEvent.keyDown(screen.getByRole('button', {name: 'Open'}), {key: 'Enter'});
    const item = screen.getByRole('menuitem', {name: /Labels/});
    expect(item.querySelector('kbd')?.textContent).toBe('L');
    expect(classConflicts(document.body)).toEqual([]);
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('Menu: Escape returns focus immediately, without stealing it back later', async () => {
    render(<><Menu>
      <MenuTrigger asChild><Button>React</Button></MenuTrigger>
      <MenuContent><MenuItem>Thumbs up</MenuItem></MenuContent>
    </Menu><Input placeholder="Comment"/></>);
    const trigger = screen.getByRole('button', {name: 'React'});
    fireEvent.keyDown(trigger, {key: 'Enter'});
    fireEvent.keyDown(screen.getByRole('menu'), {key: 'Escape'});
    expect(document.activeElement).toBe(trigger);
    const input = screen.getByPlaceholderText('Comment');
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(input);
  });

  test('ContextMenu: opens on right click with the same item rendering', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild><ListRow role="option">Row</ListRow></ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem icon={TagIcon} shortcut="L">Labels</ContextMenuItem></ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Row'));
    const item = screen.getByRole('menuitem', {name: /Labels/});
    expect(item.className).toContain('data-highlighted:bg-control-transparent-hover');
    expect(classConflicts(document.body)).toEqual([]);
  });

  test('Dialog: an explicit return target replaces a transient menu opener', async () => {
    const target = document.createElement('button');
    document.body.append(target);
    const {rerender} = render(<Dialog open title="Delete?" returnFocus={() => target} footer={<Button>Cancel</Button>}/>);
    rerender(<Dialog open={false} title="Delete?" returnFocus={() => target}/>);
    await waitFor(() => { expect(document.activeElement).toBe(target); });
    target.remove();
  });

  test('Dialog: opens with its title, Escape closes', () => {
    render(<Dialog title="Archive?" trigger={<DialogTrigger asChild><Button>Go</Button></DialogTrigger>}/>);
    fireEvent.click(screen.getByRole('button', {name: 'Go'}));
    expect(screen.getByRole('dialog', {name: 'Archive?'})).toBeTruthy();
    expect(classConflicts(document.body)).toEqual([]);
    fireEvent.keyDown(screen.getByRole('dialog'), {key: 'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('classConflicts', () => {
  test('detects a property set twice under the same variants', () => {
    const div = document.createElement('div');
    div.innerHTML = '<span class="text-default text-danger hover:bg-control-transparent-hover bg-default text-sm"></span><i class="z-popover z-tooltip"></i><b class="rounded-sm data-[state=open]:rounded-md"></b>';
    expect(classConflicts(div)).toHaveLength(2);
  });
});
