// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The command palette's parts (cmdk inside a Radix dialog). cmdk only does
// the keyboard and selection here: callers filter and rank themselves
// (shouldFilter is off), so the list renders only what is shown.

import {Command as K} from 'cmdk';
import {Search} from 'lucide-react';
import {Dialog as D} from 'radix-ui';
import type {ReactNode, Ref} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {Shortcut} from './Kbd.tsx';
import {dialogPanel, menuRow, overlay} from './recipes.ts';

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the dialog and the list. */
  label: string;
  children: ReactNode;
}

/** A modal command menu near the top of the viewport. Esc and the overlay close it. */
export function CommandDialog({open, onOpenChange, label, children}: CommandDialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay}>
          <D.Content aria-describedby={undefined} className={cx(dialogPanel, 'max-w-md overflow-hidden')}>
            <D.Title className="sr-only">{label}</D.Title>
            <K label={label} shouldFilter={false} loop>{children}</K>
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
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
    <K.Group heading={<span className="block px-2 pt-2 pb-1 text-sm text-fg-subtle">{heading}</span>}>
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
  children: ReactNode;
}

// cmdk writes data-selected / data-disabled as "true" or "false".
const item = cx(menuRow, 'text-fg data-[selected=true]:bg-raised-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-subtle');

export function CommandItem({value, onSelect, icon, leading, meta, shortcut, children}: CommandItemProps) {
  return (
    <K.Item value={value} onSelect={onSelect} className={item}>
      {icon ? <Icon icon={icon} className="text-fg-muted"/> : leading}
      <span className="min-w-0 truncate">{children}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg-subtle">{meta}</span>
      {shortcut && <Shortcut keys={shortcut}/>}
    </K.Item>
  );
}
