// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CircleAlert, CircleCheck, Info, X} from 'lucide-react';
import type {ReactNode} from 'react';
import {IconButton} from './Button.tsx';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {floating} from './recipes.ts';

const tones = {
  neutral: {icon: Info, text: 'text-fg-muted'},
  success: {icon: CircleCheck, text: 'text-success'},
  danger: {icon: CircleAlert, text: 'text-danger'},
} as const satisfies Record<string, {icon: LucideIcon; text: string}>;

export type NoticeTone = keyof typeof tones;

/** Where notices stack (bottom right, above the page and dialogs). Render it once, around the notices. */
export function NoticeViewport({children}: {children: ReactNode}) {
  return (
    <section aria-label="Notices" className="pointer-events-none fixed right-4 bottom-4 z-popover flex w-80 flex-col items-stretch gap-2">
      {children}
    </section>
  );
}

export interface NoticeProps {
  tone?: NoticeTone | undefined;
  title: string;
  description?: ReactNode;
  /** Usually one small Button (Retry, Undo). */
  action?: ReactNode;
  onDismiss: () => void;
  /** Leaving: fades out (then onClosed). */
  closing?: boolean | undefined;
  onClosed?: (() => void) | undefined;
}

/**
 * A transient message about something that happened out of view (a change
 * the server refused, a reconnect). Appears instantly, fades out when closed.
 * Danger notices are announced at once (role alert), the others politely.
 */
export function Notice({tone = 'neutral', title, description, action, onDismiss, closing, onClosed}: NoticeProps) {
  const t = tones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-state={closing ? 'closed' : 'open'}
      onAnimationEnd={closing ? onClosed : undefined}
      className={cx(floating, 'pointer-events-auto flex items-start gap-2 p-3')}
    >
      <Icon icon={t.icon} className={cx('mt-0.5', t.text)}/>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-base font-medium text-fg">{title}</p>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
        {action && <div className="flex gap-2 pt-1">{action}</div>}
      </div>
      <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} className="-mt-1 -mr-1"/>
    </div>
  );
}
