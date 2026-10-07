// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dropdown and context menus. Both are built from one item set (makeItems), so
// a row's context menu and its "…" menu offer the same rows with the same look
// and behaviour (PLAN §5.6).

import {Check, ChevronRight, Dot} from 'lucide-react';
import {ContextMenu as C, DropdownMenu as D} from 'radix-ui';
import type {ComponentProps, ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {Shortcut} from './Kbd.tsx';
import {floating, iconSlot, menuItem} from './recipes.ts';

const content = cx(floating, 'z-popover max-h-popper min-w-48 max-w-sm overflow-y-auto p-1');

export interface MenuItemProps {
  icon?: LucideIcon | undefined;
  shortcut?: string | undefined;
  /** Destructive actions are tinted. */
  danger?: boolean | undefined;
  children: ReactNode;
}

function ItemBody({icon, shortcut, children}: Omit<MenuItemProps, 'danger'>) {
  return (
    <>
      {icon && <Icon icon={icon} className="text-fg-muted group-data-disabled:text-fg-subtle"/>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Shortcut keys={shortcut} className="group-data-disabled:opacity-disabled"/>}
    </>
  );
}

// The item parts of Radix's DropdownMenu and ContextMenu have identical props.
type Parts = Pick<typeof D, 'Item' | 'CheckboxItem' | 'RadioGroup' | 'RadioItem' | 'ItemIndicator' | 'Label' | 'Separator' | 'Sub' | 'SubTrigger' | 'SubContent' | 'Portal'>;

function makeItems(P: Parts) {
  function Item({icon, shortcut, danger, children, ...rest}: MenuItemProps & Omit<ComponentProps<typeof P.Item>, 'children' | 'className' | 'style'>) {
    return (
      <P.Item className={cx(menuItem, danger ? 'text-danger' : 'text-fg')} {...rest}>
        <ItemBody icon={icon} shortcut={shortcut}>{children}</ItemBody>
      </P.Item>
    );
  }
  function CheckboxItem({shortcut, children, ...rest}: Omit<MenuItemProps, 'icon' | 'danger'> & Omit<ComponentProps<typeof P.CheckboxItem>, 'children' | 'className' | 'style'>) {
    return (
      <P.CheckboxItem className={cx(menuItem, 'text-fg')} {...rest}>
        <span className={iconSlot}>
          <P.ItemIndicator><Icon icon={Check}/></P.ItemIndicator>
        </span>
        <ItemBody shortcut={shortcut}>{children}</ItemBody>
      </P.CheckboxItem>
    );
  }
  function RadioItem({shortcut, children, ...rest}: Omit<MenuItemProps, 'icon' | 'danger'> & Omit<ComponentProps<typeof P.RadioItem>, 'children' | 'className' | 'style'>) {
    return (
      <P.RadioItem className={cx(menuItem, 'text-fg')} {...rest}>
        <span className={iconSlot}>
          <P.ItemIndicator><Icon icon={Dot}/></P.ItemIndicator>
        </span>
        <ItemBody shortcut={shortcut}>{children}</ItemBody>
      </P.RadioItem>
    );
  }
  function Label({children}: {children: ReactNode}) {
    return <P.Label className="px-2 py-1 text-sm text-fg-subtle">{children}</P.Label>;
  }
  function Separator() {
    return <P.Separator className="-mx-1 my-1 h-px bg-border"/>;
  }
  /** A nested menu: <Sub label="Labels" icon={Tag}>…items…</Sub>. */
  function Sub({label, icon, children}: {label: ReactNode; icon?: LucideIcon | undefined; children: ReactNode}) {
    return (
      <P.Sub>
        <P.SubTrigger className={cx(menuItem, 'text-fg data-[state=open]:bg-raised-hover')}>
          <ItemBody icon={icon}>{label}</ItemBody>
          <Icon icon={ChevronRight} size="sm" className="text-fg-muted"/>
        </P.SubTrigger>
        <P.Portal>
          <P.SubContent sideOffset={4} className={content}>{children}</P.SubContent>
        </P.Portal>
      </P.Sub>
    );
  }
  return {Item, CheckboxItem, RadioGroup: P.RadioGroup, RadioItem, Label, Separator, Sub};
}

// ── Dropdown menu ────────────────────────────────────────────────────────────

const dropdown = /* @__PURE__ */ makeItems(D);

export const Menu = D.Root;
export const MenuTrigger = D.Trigger;
export const {
  Item: MenuItem, CheckboxItem: MenuCheckboxItem, RadioGroup: MenuRadioGroup, RadioItem: MenuRadioItem,
  Label: MenuLabel, Separator: MenuSeparator, Sub: MenuSub,
} = dropdown;

export function MenuContent({sideOffset = 4, align = 'start', ...rest}: Omit<ComponentProps<typeof D.Content>, 'className' | 'style'>) {
  return (
    <D.Portal>
      <D.Content sideOffset={sideOffset} align={align} className={content} {...rest}/>
    </D.Portal>
  );
}

// ── Context menu (right click / long press / Shift+F10 on a row) ─────────────

const context = /* @__PURE__ */ makeItems(C);

export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;
export const {
  Item: ContextMenuItem, CheckboxItem: ContextMenuCheckboxItem, RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator, Sub: ContextMenuSub,
} = context;

export function ContextMenuContent(props: Omit<ComponentProps<typeof C.Content>, 'className' | 'style'>) {
  return (
    <C.Portal>
      <C.Content className={content} {...props}/>
    </C.Portal>
  );
}
