// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Dialog as D} from 'radix-ui';
import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {dialogPanel, overlay} from './recipes.ts';
import {useReturnFocus} from './returnFocus.ts';

export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const widths = {sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg'} as const;

export interface DialogProps {
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Uncontrolled: the element that opens the dialog (wrap it in <DialogTrigger asChild>). */
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  size?: keyof typeof widths | undefined;
  /**
   * Where the focus goes when it opens: the first control (a form's field), or the dialog itself — for a
   * dialog whose first control is a per-row action (a Discard button): nothing is triggered by a stray Enter or
   * Space, no tooltip opens, and one Esc closes it.
   */
  initialFocus?: 'first' | 'dialog' | undefined;
  /**
   * A body that can be long (a list): it scrolls inside the dialog (at most --spacing-dialog-body tall), so the
   * title and the footer's buttons stay on screen, and its scrolling never chains to the page.
   */
  scroll?: boolean | undefined;
  children?: ReactNode;
}

/** A modal dialog near the top of the viewport; Esc and the overlay close it. */
export function Dialog({open, onOpenChange, trigger, title, description, footer, size = 'md', initialFocus = 'first', scroll, children}: DialogProps) {
  const ret = useReturnFocus();
  const focus = initialFocus === 'first' ? ret : {
    ...ret,
    onOpenAutoFocus: (e: Event) => {
      ret.onOpenAutoFocus();
      e.preventDefault();
      (e.currentTarget as HTMLElement | null)?.focus({preventScroll: true});
    },
  };
  return (
    <D.Root {...(open === undefined ? {} : {open})} {...(onOpenChange ? {onOpenChange} : {})}>
      {trigger}
      <D.Portal>
        <D.Overlay className={overlay}>
          <D.Content
            {...focus}
            {...(description ? {} : {'aria-describedby': undefined})}
            className={cx(dialogPanel, 'flex flex-col gap-3 p-4 focus-visible:outline-none', widths[size])}>
            <div className="flex flex-col gap-1">
              <D.Title className="text-md font-semibold">{title}</D.Title>
              {description && <D.Description className="text-base text-fg-muted">{description}</D.Description>}
            </div>
            {children && <div className={scroll ? 'max-h-dialog-body overflow-y-auto overscroll-contain' : undefined}>{children}</div>}
            {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}
