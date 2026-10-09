// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The command palette's parts (cmdk inside a Radix dialog). cmdk only does
// the keyboard and selection here: callers filter and rank themselves
// (shouldFilter is off), so the list renders only what is shown.
// CommandPopover is the same list in a popover under a button: every picker
// that chooses from more than a handful of values (a branch, a label, a
// person) filters as you type and takes the first match on Enter.

import {Command as K} from 'cmdk';
import {Check, Minus, Search} from 'lucide-react';
import {Dialog as D} from 'radix-ui';
import {type ReactElement, type ReactNode, type Ref, useState} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {ItemBody} from './ItemBody.tsx';
import {Popover, PopoverContent, PopoverTrigger} from './Popover.tsx';
import {dialogPanel, iconSlot, menuRow, overlay, sectionLabel} from './recipes.ts';
import {useReturnFocus} from './returnFocus.ts';

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the dialog and the list. */
  label: string;
  /** The children render their own CommandRoot (a caller that controls the selection). */
  bare?: boolean | undefined;
  /** Whether closing gives the focus back to what had it (false after a command that navigated). */
  restoreFocus?: (() => boolean) | undefined;
  children: ReactNode;
}

/**
 * A modal command menu near the top of the viewport. Esc and the overlay close it.
 *
 * Modal to the user (aria-modal, the overlay takes the pointer, Tab stays in it: its only tab stop is the input) but
 * not to Radix: a Radix modal sets `pointer-events: none` on the body (inherited: every element's style is
 * recomputed) and hides the page's other elements from assistive technology one by one, which made opening ⌘K a
 * 60–70 ms task at 4× CPU (QA verify3); the palette is opened by a key and must open within a frame or two.
 */
export function CommandDialog({open, onOpenChange, label, bare = false, restoreFocus, children}: CommandDialogProps) {
  const focus = useReturnFocus(restoreFocus);
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <D.Portal>
        <div className={overlay} data-state={open ? 'open' : 'closed'}>
          <D.Content {...focus} aria-describedby={undefined} aria-modal className={cx(dialogPanel, 'max-w-md overflow-hidden')}
            onKeyDown={(e) => {
              // Tab never leaves the menu (nothing behind it is reachable while it is open).
              if (e.key === 'Tab') e.preventDefault();
            }}>
            <D.Title className="sr-only">{label}</D.Title>
            {bare ? children : <K label={label} shouldFilter={false} loop vimBindings={false}>{children}</K>}
          </D.Content>
        </div>
      </D.Portal>
    </D.Root>
  );
}

/**
 * The command list's root inside a `bare` CommandDialog, with the selection controlled: `value` is the
 * selected item's value (the caller picks the first one whenever the results change).
 */
export function CommandRoot({label, value, onValueChange, children}: {label: string; value: string; onValueChange: (v: string) => void; children: ReactNode}) {
  // No vim bindings: Ctrl+K is the palette's own key (it must close and reopen it, never move the selection).
  return <K label={label} shouldFilter={false} loop vimBindings={false} value={value} onValueChange={onValueChange}>{children}</K>;
}

export interface CommandInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ref?: Ref<HTMLInputElement>;
}

export function CommandInput({value, onValueChange, placeholder, ref}: CommandInputProps) {
  return (
    <div className="flex h-header items-center gap-2 border-b border-border px-3">
      <Icon icon={Search} className="text-fg-subtle"/>
      <K.Input
        ref={ref}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-subtle"
      />
    </div>
  );
}

export function CommandList({children}: {children: ReactNode}) {
  return <K.List className="max-h-96 scroll-py-1 overflow-y-auto p-1">{children}</K.List>;
}

export function CommandEmpty({children}: {children: ReactNode}) {
  return <K.Empty className="px-2 py-6 text-center text-base text-fg-muted">{children}</K.Empty>;
}

export function CommandGroup({heading, children}: {heading: string; children: ReactNode}) {
  return (
    <K.Group heading={<span className={cx(sectionLabel, 'block px-2 pt-2 pb-1')}>{heading}</span>}>
      {children}
    </K.Group>
  );
}

export interface CommandItemProps {
  /** Unique and stable within the list (cmdk tracks the selection by it). */
  value: string;
  onSelect: () => void;
  icon?: LucideIcon | undefined;
  /** Instead of an icon (an avatar). */
  leading?: ReactNode;
  /** Muted text after the title (a repository name, a state). */
  meta?: ReactNode;
  shortcut?: string | undefined;
  /** A choice that is on (true), on for some (mixed) or off (false): a check slot and aria-checked. */
  checked?: boolean | 'mixed' | undefined;
  /** Listed but cannot run now (its meta says why): shown as disabled, still selectable so that Enter can say why. */
  muted?: boolean | undefined;
  children: ReactNode;
}

// cmdk writes data-selected / data-disabled as "true" or "false".
const item = cx(menuRow, 'text-fg data-muted:text-fg-subtle data-[selected=true]:bg-raised-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-subtle');

export function CommandItem({value, onSelect, icon, leading, meta, shortcut, checked, muted, children}: CommandItemProps) {
  return (
    <K.Item value={value} onSelect={onSelect} className={item} aria-checked={checked} data-muted={muted ? true : undefined}>
      {checked !== undefined && (
        <span className={iconSlot}>{checked && <Icon icon={checked === 'mixed' ? Minus : Check}/>}</span>
      )}
      <ItemBody icon={icon} leading={leading} meta={meta ?? ''} shortcut={shortcut}>{children}</ItemBody>
    </K.Item>
  );
}

/** One choice of a CommandPopover. */
export interface PickOption {
  /** Unique within the popover. */
  value: string;
  /** Shown, and matched by the query. */
  label: string;
  /** Matched by the query besides the label (a login, a description). */
  words?: string | undefined;
  /** The heading of its group; groups appear in the order of their first option. */
  group?: string | undefined;
  icon?: LucideIcon | undefined;
  leading?: ReactNode;
  meta?: ReactNode;
  /** On (true), on for some (mixed), off (false); undefined: an action, no check slot. */
  checked?: boolean | 'mixed' | undefined;
  /** Stays open after choosing (multi-value fields: labels). */
  keepOpen?: boolean | undefined;
  onSelect: () => void;
}

export interface CommandPopoverProps {
  /** The button that opens it (rendered as the trigger). */
  trigger: ReactElement;
  /** Accessible name of the list. */
  label: string;
  placeholder: string;
  options: readonly PickOption[];
  /** Said when there is nothing at all to choose from. */
  empty?: ReactNode;
  width?: 'sm' | 'md';
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * The list, rendered only while open (instead of `options`): a caller whose choices are costly to compute or
   * change while it is open (an observer) renders its own CommandPick.
   */
  render?: ((onClose: () => void) => ReactNode) | undefined;
}

/** The options matching every word of the query (in the label or the extra words). */
export function matchOptions(options: readonly PickOption[], query: string): readonly PickOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = `${o.label} ${o.words ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** A filterable list of choices under a button (Linear's pickers): type to narrow, Enter takes the first match. */
export function CommandPopover({trigger, label, placeholder, options, empty = 'No choices here.', width = 'sm', onOpenChange, render}: CommandPopoverProps) {
  const [open, setOpen] = useState(false);
  const onClose = () => {
    setOpen(false);
    onOpenChange?.(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      onOpenChange?.(o);
    }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent width={width}>
        {render ? render(onClose) : <CommandPick label={label} placeholder={placeholder} options={options} empty={empty} onClose={onClose}/>}
      </PopoverContent>
    </Popover>
  );
}

export interface CommandPickProps {
  label: string;
  placeholder: string;
  options: readonly PickOption[];
  empty: ReactNode;
  onClose: () => void;
  /** What the choice applies to, above the field (a picker opened by a key: "#12 Fix the login"). */
  target?: ReactNode;
  /** The query, when the caller searches itself (`filtered`: the options are the query's matches already). */
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  filtered?: boolean | undefined;
}

/**
 * The list of a picker (in a CommandPopover, or a CommandDialog's `bare` content): type to narrow, Enter takes the
 * first match; it opens on the current choice, so Enter right away keeps it.
 */
export function CommandPick({label, placeholder, options, empty, onClose, target, query: outer, onQueryChange, filtered}: CommandPickProps) {
  const [own, setOwn] = useState('');
  const query = outer ?? own;
  const setQuery = (q: string) => {
    setOwn(q);
    onQueryChange?.(q);
  };
  const shown = filtered ? options : matchOptions(options, query);
  const first = shown[0]?.value ?? '';
  // Opens on the current choice; the first match is selected whenever the query changes (Enter takes it).
  // The current value of a one-value field (status, priority, milestone); a multi-value field (labels) opens on its first
  // option, never on one that Enter would take away.
  const [selected, setSelected] = useState(() => options.find((o) => o.checked === true && !o.keepOpen)?.value ?? first);
  const [seen, setSeen] = useState(query);
  if (seen !== query) {
    setSeen(query);
    setSelected(first);
  }
  const groups = new Map<string, PickOption[]>();
  for (const o of shown) {
    const g = groups.get(o.group ?? '');
    if (g) g.push(o);
    else groups.set(o.group ?? '', [o]);
  }
  const item = (o: PickOption) => (
    <CommandItem key={o.value} value={o.value} icon={o.icon} leading={o.leading} meta={o.meta} checked={o.checked} onSelect={() => {
      o.onSelect();
      if (!o.keepOpen) onClose();
    }}>{o.label}</CommandItem>
  );
  return (
    <CommandRoot label={label} value={selected} onValueChange={setSelected}>
      {target && <p className="truncate px-3 pt-2 text-sm text-fg-muted">{target}</p>}
      <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder}/>
      <CommandList>
        {!shown.length && <CommandEmpty>{options.length ? 'Nothing matches.' : empty}</CommandEmpty>}
        {[...groups].map(([g, os]) => (g ? <CommandGroup key={g} heading={g}>{os.map(item)}</CommandGroup> : os.map(item)))}
      </CommandList>
    </CommandRoot>
  );
}
