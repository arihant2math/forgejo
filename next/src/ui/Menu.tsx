// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dropdown and context menus. Both use the same item rendering, so a row's
// context menu and its "…" menu look and behave identically (PLAN §5.6).

import {Check} from 'lucide-react';
import {ContextMenu as C, DropdownMenu as D} from 'radix-ui';
import type {ComponentProps, ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {Shortcut} from './Kbd.tsx';
import {floating, menuItem} from './recipes.ts';

const content = cx(floating, 'z-popover min-w-48 max-w-sm p-1');
const separator = '-mx-1 my-1 h-px bg-border';
const label = 'px-2 py-1 text-sm text-fg-subtle';

export interface MenuItemProps {
  icon?: LucideIcon | undefined;
  shortcut?: string | undefined;
  /** Destructive actions are tinted. */
  danger?: boolean | undefined;
  children: ReactNode;
}

function ItemBody({icon, shortcut, children}: MenuItemProps) {
  return (
    <>
      {icon && <Icon icon={icon} className="text-fg-muted"/>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Shortcut keys={shortcut}/>}
    </>
  );
}

const itemClass = (danger?: boolean) => cx(menuItem, danger ? 'text-danger' : 'text-fg');

// ── Dropdown menu ────────────────────────────────────────────────────────────

export const Menu = D.Root;
export const MenuTrigger = D.Trigger;

export function MenuContent({className, sideOffset = 4, align = 'start', ...rest}: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Content sideOffset={sideOffset} align={align} className={cx(content, className)} {...rest}/>
    </D.Portal>
  );
}

export function MenuItem({icon, shortcut, danger, children, ...rest}: MenuItemProps & Omit<ComponentProps<typeof D.Item>, 'children'>) {
  return (
    <D.Item className={itemClass(danger)} {...rest}>
      <ItemBody icon={icon} shortcut={shortcut}>{children}</ItemBody>
    </D.Item>
  );
}

export function MenuCheckboxItem({shortcut, children, ...rest}: Omit<MenuItemProps, 'icon' | 'danger'> & Omit<ComponentProps<typeof D.CheckboxItem>, 'children'>) {
  return (
    <D.CheckboxItem className={itemClass()} {...rest}>
      <span className="flex size-4 items-center justify-center">
        <D.ItemIndicator><Icon icon={Check}/></D.ItemIndicator>
      </span>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </D.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <D.Separator className={separator}/>;
}

export function MenuLabel({children}: {children: ReactNode}) {
  return <D.Label className={label}>{children}</D.Label>;
}

// ── Context menu (right click / long press on a row) ─────────────────────────

export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;

export function ContextMenuContent({className, ...rest}: ComponentProps<typeof C.Content>) {
  return (
    <C.Portal>
      <C.Content className={cx(content, className)} {...rest}/>
    </C.Portal>
  );
}

export function ContextMenuItem({icon, shortcut, danger, children, ...rest}: MenuItemProps & Omit<ComponentProps<typeof C.Item>, 'children'>) {
  return (
    <C.Item className={itemClass(danger)} {...rest}>
      <ItemBody icon={icon} shortcut={shortcut}>{children}</ItemBody>
    </C.Item>
  );
}

export function ContextMenuSeparator() {
  return <C.Separator className={separator}/>;
}
