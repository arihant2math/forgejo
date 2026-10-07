// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Dialog as D} from 'radix-ui';
import type {ReactNode} from 'react';

export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled: the element that opens the dialog (wrap it in <DialogTrigger asChild>). */
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  children?: ReactNode;
}

/** A modal dialog near the top of the viewport; Esc and the overlay close it. */
export function Dialog({open, onOpenChange, trigger, title, description, footer, children}: DialogProps) {
  return (
    <D.Root {...(open === undefined ? {} : {open})} {...(onOpenChange ? {onOpenChange} : {})}>
      {trigger}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto bg-overlay px-4 pt-24 pb-8 data-[state=closed]:animate-exit">
          <D.Content className="w-full max-w-md rounded-lg pb-4 border border-border bg-raised text-fg shadow-dialog outline-none data-[state=closed]:animate-exit-pop">
            <div className="flex flex-col gap-1 px-4 pt-4">
              <D.Title className="text-md font-semibold">{title}</D.Title>
              {description ?
                <D.Description className="text-base text-fg-muted">{description}</D.Description> :
                <D.Description className="sr-only">{title}</D.Description>}
            </div>
            {children && <div className="px-4 pt-3">{children}</div>}
            {footer && <div className="flex justify-end gap-2 px-4 pt-4">{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}
