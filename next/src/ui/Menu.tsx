// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dropdown and context menus. Both are built from one item set (makeItems), so
// a row's context menu and its "…" menu offer the same rows with the same look
// and behaviour (PLAN §5.6).
import {Button} from './Button.tsx';
import {ContextMenu as C, DropdownMenu as D} from 'radix-ui';
import {type ComponentProps, type ReactNode, useRef} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {ItemBody} from './ItemBody.tsx';
import {floating, iconSlot, menuItem, sectionLabel} from './recipes.ts';
import {CheckIcon, ChevronDownIcon, ChevronRightIcon, DotFillIcon, KebabHorizontalIcon} from '@primer/octicons-react';

const EDGE_GAP = 8;
const content = cx(floating, 'z-popover max-h-popper min-w-48 max-w-menu overflow-y-auto p-1');

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
    const cls = cx(menuItem, danger ? 'text-danger' : 'text-default');
    if (href !== undefined) return <P.Item asChild className={cls} {...rest}><a href={href} data-classic={classic ? '' : undefined}>{body}</a></P.Item>;
    return <P.Item className={cls} {...rest}>{body}</P.Item>;
  }
  function CheckboxItem({shortcut, children, ...rest}: Omit<MenuItemProps, 'icon' | 'danger'> & Omit<ComponentProps<typeof P.CheckboxItem>, 'children' | 'className' | 'style'>) {
    return (
      <P.CheckboxItem className={cx(menuItem, 'text-default')} {...rest}>
        <span className={iconSlot}>
          <P.ItemIndicator><Icon icon={CheckIcon}/></P.ItemIndicator>
        </span>
        <ItemBody shortcut={shortcut}>{children}</ItemBody>
      </P.CheckboxItem>
    );
  }
  function RadioItem({shortcut, children, ...rest}: Omit<MenuItemProps, 'icon' | 'danger'> & Omit<ComponentProps<typeof P.RadioItem>, 'children' | 'className' | 'style'>) {
    return (
      <P.RadioItem className={cx(menuItem, 'text-default')} {...rest}>
        <span className={iconSlot}>
          <P.ItemIndicator><Icon icon={DotFillIcon}/></P.ItemIndicator>
        </span>
        <ItemBody shortcut={shortcut}>{children}</ItemBody>
      </P.RadioItem>
    );
  }
  function Label({children}: {children: ReactNode}) {
    return <P.Label className={cx(sectionLabel, 'px-2 py-1')}>{children}</P.Label>;
  }
  function Separator() {
    return <P.Separator className="-mx-1 my-1 h-px bg-neutral-muted"/>;
  }
  /** A nested menu: <Sub label="Labels" icon={Tag}>…items…</Sub>. */
  function Sub({label, icon, children}: {label: ReactNode; icon?: LucideIcon | undefined; children: ReactNode}) {
    return (
      <P.Sub>
        <P.SubTrigger className={cx(menuItem, 'text-default data-[state=open]:bg-control-transparent-hover')}>
          <ItemBody icon={icon}>{label}</ItemBody>
          <Icon icon={ChevronRightIcon} size="sm" className="text-muted"/>
        </P.SubTrigger>
        <P.Portal>
          <P.SubContent sideOffset={4} collisionPadding={EDGE_GAP} sticky="always" className={content}>{children}</P.SubContent>
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

/**
 * A menu item that opened a dialog ("Rename…", "New issue in this column…"): the dialog keeps the focus. Radix
 * gives it back to the menu's trigger when the menu has faded out, behind the dialog, so typing went nowhere. And
 * the fading menu takes the focus back itself (its item's pointer-leave focuses the menu, which then unmounts): the
 * dialog's first field gets it again.
 */
function keepDialogFocus(e: Event): void {
  const open = [...document.querySelectorAll<HTMLElement>('div[role="dialog"], div[role="alertdialog"]')]
    .find((d) => d.dataset.state !== 'closed' && !d.closest('div[role="menu"]'));
  if (!open) return;
  e.preventDefault();
  if (open.contains(document.activeElement)) return;
  const field = open.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, div[contenteditable="true"]') ??
    open.querySelector<HTMLElement>('button:not([disabled])');
  (field ?? open).focus();
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

export function MenuContent({sideOffset = 4, align = 'start', onCloseAutoFocus, onEscapeKeyDown, ...rest}: Omit<ComponentProps<typeof D.Content>, 'className' | 'style' | 'ref'>) {
  const ref = useRef<HTMLDivElement>(null);
  const escaped = useRef(false);
  return (
    <D.Portal>
      <D.Content ref={ref} collisionPadding={EDGE_GAP} sideOffset={sideOffset} align={align} className={content} onFocusOutside={keepOnFocusOutside} onPointerDownOutside={(e) => {
        if (onOwnTrigger(e, ref.current)) e.preventDefault();
      }} onEscapeKeyDown={(e) => {
        onEscapeKeyDown?.(e);
        if (e.defaultPrevented) return;
        // Release the keys now, not after the exit animation; its delayed autofocus must not steal them back.
        escaped.current = true;
        const id = ref.current?.id;
        const trigger = [...document.querySelectorAll<HTMLElement>('button[aria-controls]')].find((el) => el.getAttribute('aria-controls') === id);
        trigger?.focus({preventScroll: true});
      }} onCloseAutoFocus={(e) => {
        if (escaped.current) e.preventDefault();
        escaped.current = false;
        onCloseAutoFocus?.(e);
        keepDialogFocus(e);
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
/** The element the last context menu was opened on (a list): the menu gives the focus back to it when it closes. */
let opener: HTMLElement | null = null;

export function ContextMenuTrigger({onContextMenuCapture, ...props}: ComponentProps<typeof C.Trigger>) {
  return <C.Trigger onContextMenuCapture={(e) => {
    opener = e.currentTarget;
    onContextMenuCapture?.(e);
  }} {...props}/>;
}
export const {
  Item: ContextMenuItem, CheckboxItem: ContextMenuCheckboxItem, RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator, Sub: ContextMenuSub,
} = context;

/**
 * Keeps a context menu inside the viewport across: Radix places it beside the pointer and shifts it only along that
 * side, so where neither side of the pointer has room for it (the middle of a phone's screen) it ran off an edge.
 * Nudges the menu (CSS translate, apart from Radix's transform) whenever Radix moves it (a ref: with the element).
 */
function insideViewport(node: HTMLElement | null): (() => void) | undefined {
  const wrapper = node?.parentElement;
  if (!node || !wrapper) return undefined;
  const fit = () => {
    const r = wrapper.getBoundingClientRect();
    const right = (document.documentElement.clientWidth || innerWidth) - EDGE_GAP;
    const dx = r.left < EDGE_GAP ? EDGE_GAP - r.left : r.right > right ? Math.max(EDGE_GAP - r.left, right - r.right) : 0;
    node.style.translate = dx ? `${String(Math.round(dx))}px 0` : '';
  };
  fit();
  const moved = new MutationObserver(fit);
  moved.observe(wrapper, {attributes: true, attributeFilter: ['style']});
  addEventListener('resize', fit);
  return () => {
    moved.disconnect();
    removeEventListener('resize', fit);
  };
}

export function ContextMenuContent({onCloseAutoFocus, ...props}: Omit<ComponentProps<typeof C.Content>, 'className' | 'style' | 'ref'>) {
  return (
    <C.Portal>
      <C.Content ref={insideViewport} collisionPadding={EDGE_GAP} sticky="always" className={content} onFocusOutside={keepOnFocusOutside} onCloseAutoFocus={(e) => {
        onCloseAutoFocus?.(e);
        keepDialogFocus(e);
        // Back to the list it was opened on (its cursor shows, J/K go on), not to the row the right click focused,
        // which then wore a focus outline instead of the cursor's edge.
        if (!e.defaultPrevented && opener?.isConnected && opener.tabIndex >= 0) {
          e.preventDefault();
          opener.focus({preventScroll: true});
        }
      }} {...props}/>
    </C.Portal>
  );
}

/**
 * A page header's "More" menu (a repository's, an owner's): the one trigger look (ghost, "More", a chevron) and
 * its items — the place for what is secondary, such as the "In the classic UI" group.
 */
export function MoreMenu({label, children}: {label: string; children: ReactNode}) {
  return (
    <Menu>
      <D.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={label}><Icon icon={KebabHorizontalIcon} size="sm"/>More<Icon icon={ChevronDownIcon} size="sm"/></Button>
      </D.Trigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}
