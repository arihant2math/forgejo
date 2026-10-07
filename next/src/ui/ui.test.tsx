// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {Plus, Tag} from 'lucide-react';
import {describe, expect, test, vi} from 'vitest';
import {
  Avatar, Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Dialog, DialogTrigger, IconButton,
  Input, LabelChip, ListRow, Menu, MenuContent, MenuItem, MenuTrigger, Shortcut, TooltipProvider,
} from './index.ts';
import {classConflicts} from '../test/conflicts.ts';

describe('primitives', () => {
  test('Button: type=button by default, variant and size classes, icon', () => {
    render(<Button variant="primary" size="sm" icon={Plus}>New</Button>);
    const b = screen.getByRole('button', {name: 'New'});
    expect(b.getAttribute('type')).toBe('button');
    expect(b.className).toContain('bg-accent');
    expect(b.className).toContain('h-control-sm');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('IconButton: accessible name from label', () => {
    render(<TooltipProvider><IconButton icon={Plus} label="Create issue" shortcut="C"/></TooltipProvider>);
    expect(screen.getByRole('button', {name: 'Create issue'}).className).toContain('size-control');
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
    const {container} = render(<LabelChip name="bug" color="var(--color-danger)"/>);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--label-color')).toBe('var(--color-danger)');
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
          <MenuItem icon={Tag} shortcut="L" onSelect={onSelect}>Labels</MenuItem>
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

  test('ContextMenu: opens on right click with the same item rendering', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild><ListRow role="option">Row</ListRow></ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem icon={Tag} shortcut="L">Labels</ContextMenuItem></ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Row'));
    const item = screen.getByRole('menuitem', {name: /Labels/});
    expect(item.className).toContain('data-highlighted:bg-hover');
    expect(classConflicts(document.body)).toEqual([]);
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
    div.innerHTML = '<span class="text-fg text-danger hover:bg-hover bg-surface text-sm"></span><i class="z-popover z-tooltip"></i><b class="rounded-sm data-[state=open]:rounded-md"></b>';
    expect(classConflicts(div)).toHaveLength(2);
  });
});
