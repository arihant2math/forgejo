// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dropdown and context menus. Both are built from one item set (makeItems), so
// a row's context menu and its "…" menu offer the same rows with the same look
// and behaviour (PLAN §5.6).

import {Check, ChevronRight, Dot} from 'lucide-react';
import {ContextMenu as C, DropdownMenu as D} from 'radix-ui';
import {type ComponentProps, type ReactNode, useRef} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {ItemBody} from './ItemBody.tsx';
import {floating, iconSlot, menuItem, sectionLabel} from './recipes.ts';

const content = cx(floating, 'z-popover max-h-popper min-w-48 max-w-sm overflow-y-auto p-1');

export interface MenuItemProps {
  icon?: LucideIcon | undefined;
  shortcut?: string | undefined;
  /** Destructive actions are tinted. */
  danger?: boolean | undefined;
  /** A link (a real anchor: middle-click and "copy link" work); selecting it follows the link. */
  href?: string | undefined;
  /** Muted text after the label. */
  hint?: string | undefined;
  /** The link opens a classic Forgejo page (hinted "classic"; the anchor is marked data-classic). */
  classic?: boolean | undefined;
  children: ReactNode;
}

// The item parts of Radix's DropdownMenu and ContextMenu have identical props.
type Parts = Pick<typeof D, 'Item' | 'CheckboxItem' | 'RadioGroup' | 'RadioItem' | 'ItemIndicator' | 'Label' | 'Separator' | 'Sub' | 'SubTrigger' | 'SubContent' | 'Portal'>;

function makeItems(P: Parts) {
  function Item({icon, shortcut, danger, href, hint, classic, children, ...rest}: MenuItemProps & Omit<ComponentProps<typeof P.Item>, 'children' | 'className' | 'style' | 'asChild'>) {
    const body = <ItemBody icon={icon} shortcut={shortcut} meta={hint ?? (classic ? 'classic' : undefined)}>{children}</ItemBody>;
    const cls = cx(menuItem, danger ? 'text-danger' : 'text-fg');
    if (href !== undefined) return <P.Item asChild className={cls} {...rest}><a href={href} data-classic={classic ? '' : undefined}>{body}</a></P.Item>;
    return <P.Item className={cls} {...rest}>{body}</P.Item>;
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
    return <P.Label className={cx(sectionLabel, 'px-2 py-1')}>{children}</P.Label>;
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

/**
 * A menu (not modal, see Menu) closes on a click outside, Esc or a choice, not when focus moves out by itself: a
 * menu reopened while the last one still fades out would close again when that one hands the focus back to its
 * trigger. Tab does not leave a menu (Radix keeps it in).
 */
function keepOnFocusOutside(e: Event): void {
  e.preventDefault();
}

/**
 * A press on the menu's own trigger is the trigger's (it toggles the menu), not a press outside: a menu reopened
 * while it still fades out keeps its outside-press listener, which would close it again at once.
 */
function onOwnTrigger(e: CustomEvent<{originalEvent: PointerEvent}>, content: HTMLElement | null): boolean {
  const id = content?.id;
  for (let el = e.detail.originalEvent.target instanceof Element ? e.detail.originalEvent.target : null; id && el; el = el.parentElement) {
    if (el.getAttribute('aria-controls') === id) return true;
  }
  return false;
}

const dropdown = /* @__PURE__ */ makeItems(D);

/**
 * Not modal: a modal menu locks the page's scroll and pointer events with styles on <body>, and the whole
 * document's styles are computed again on open and close (≈ 200 ms on a long list with a slow CPU). Outside
 * clicks still close it; focus still moves into it and back.
 */
export function Menu(props: ComponentProps<typeof D.Root>) {
  return <D.Root modal={false} {...props}/>;
}
export const MenuTrigger = D.Trigger;
export const {
  Item: MenuItem, CheckboxItem: MenuCheckboxItem, RadioGroup: MenuRadioGroup, RadioItem: MenuRadioItem,
  Label: MenuLabel, Separator: MenuSeparator, Sub: MenuSub,
} = dropdown;

export function MenuContent({sideOffset = 4, align = 'start', ...rest}: Omit<ComponentProps<typeof D.Content>, 'className' | 'style' | 'ref'>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <D.Portal>
      <D.Content ref={ref} sideOffset={sideOffset} align={align} className={content} onFocusOutside={keepOnFocusOutside} onPointerDownOutside={(e) => {
        if (onOwnTrigger(e, ref.current)) e.preventDefault();
      }} {...rest}/>
    </D.Portal>
  );
}

// ── Context menu (right click / long press / Shift+F10 on a row) ─────────────

const context = /* @__PURE__ */ makeItems(C);

/** Not modal, as Menu. */
export function ContextMenu(props: ComponentProps<typeof C.Root>) {
  return <C.Root modal={false} {...props}/>;
}
export const ContextMenuTrigger = C.Trigger;
export const {
  Item: ContextMenuItem, CheckboxItem: ContextMenuCheckboxItem, RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator, Sub: ContextMenuSub,
} = context;

export function ContextMenuContent(props: Omit<ComponentProps<typeof C.Content>, 'className' | 'style'>) {
  return (
    <C.Portal>
      <C.Content className={content} onFocusOutside={keepOnFocusOutside} {...props}/>
    </C.Portal>
  );
}
