// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Dialog as D} from 'radix-ui';
import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {surface} from './recipes.ts';

export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const widths = {sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg'} as const;

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled: the element that opens the dialog (wrap it in <DialogTrigger asChild>). */
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  size?: keyof typeof widths;
  children?: ReactNode;
}

/** A modal dialog near the top of the viewport; Esc and the overlay close it. */
export function Dialog({open, onOpenChange, trigger, title, description, footer, size = 'md', children}: DialogProps) {
  return (
    <D.Root {...(open === undefined ? {} : {open})} {...(onOpenChange ? {onOpenChange} : {})}>
      {trigger}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto bg-overlay px-4 pt-24 pb-8 data-[state=closed]:animate-exit">
          <D.Content className={cx(surface, 'flex w-full flex-col gap-3 p-4 shadow-dialog outline-none data-[state=closed]:animate-exit-pop', widths[size])}>
            <div className="flex flex-col gap-1">
              <D.Title className="text-md font-semibold">{title}</D.Title>
              {description ?
                <D.Description className="text-base text-fg-muted">{description}</D.Description> :
                <D.Description className="sr-only">{title}</D.Description>}
            </div>
            {children}
            {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}
