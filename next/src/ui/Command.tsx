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
  children: ReactNode;
}

/** A modal command menu near the top of the viewport. Esc and the overlay close it. */
export function CommandDialog({open, onOpenChange, label, bare = false, children}: CommandDialogProps) {
  const focus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay}>
          <D.Content {...focus} aria-describedby={undefined} className={cx(dialogPanel, 'max-w-md overflow-hidden')}>
            <D.Title className="sr-only">{label}</D.Title>
            {bare ? children : <K label={label} shouldFilter={false} loop>{children}</K>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

/**
 * The command list's root inside a `bare` CommandDialog, with the selection controlled: `value` is the
 * selected item's value (the caller picks the first one whenever the results change).
 */
export function CommandRoot({label, value, onValueChange, children}: {label: string; value: string; onValueChange: (v: string) => void; children: ReactNode}) {
  return <K label={label} shouldFilter={false} loop value={value} onValueChange={onValueChange}>{children}</K>;
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
  children: ReactNode;
}

// cmdk writes data-selected / data-disabled as "true" or "false".
const item = cx(menuRow, 'text-fg data-[selected=true]:bg-raised-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-subtle');

export function CommandItem({value, onSelect, icon, leading, meta, shortcut, checked, children}: CommandItemProps) {
  return (
    <K.Item value={value} onSelect={onSelect} className={item} aria-checked={checked}>
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
export function CommandPopover({trigger, label, placeholder, options, empty = 'No choices here.', width = 'sm', onOpenChange}: CommandPopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      onOpenChange?.(o);
    }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent width={width}>
        <CommandPick label={label} placeholder={placeholder} options={options} empty={empty} onClose={() => {
          setOpen(false);
          onOpenChange?.(false);
        }}/>
      </PopoverContent>
    </Popover>
  );
}

function CommandPick({label, placeholder, options, empty, onClose}: {label: string; placeholder: string; options: readonly PickOption[]; empty: ReactNode; onClose: () => void}) {
  const [query, setQuery] = useState('');
  const shown = matchOptions(options, query);
  const first = shown[0]?.value ?? '';
  // Opens on the current choice; the first match is selected whenever the query changes (Enter takes it).
  const [selected, setSelected] = useState(() => options.find((o) => o.checked === true)?.value ?? first);
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
      <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder}/>
      <CommandList>
        {!shown.length && <CommandEmpty>{options.length ? 'Nothing matches.' : empty}</CommandEmpty>}
        {[...groups].map(([g, os]) => (g ? <CommandGroup key={g} heading={g}>{os.map(item)}</CommandGroup> : os.map(item)))}
      </CommandList>
    </CommandRoot>
  );
}
