// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CircleAlert, CircleCheck, Info, TriangleAlert, X} from 'lucide-react';
import type {ReactNode} from 'react';
import {IconButton} from './Button.tsx';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {floating, message} from './recipes.ts';

/** The tones of a message (Notice, Callout): icon and colour. */
export const messageTones = {
  neutral: {icon: Info, text: 'text-fg-muted'},
  success: {icon: CircleCheck, text: 'text-success'},
  warning: {icon: TriangleAlert, text: 'text-warning'},
  danger: {icon: CircleAlert, text: 'text-danger'},
} as const satisfies Record<string, {icon: LucideIcon; text: string}>;

const tones = messageTones;

export type NoticeTone = keyof typeof tones;

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
  /** The pointer or focus entered / left the notice (pause its timer). */
  onHold?: ((held: boolean) => void) | undefined;
}

/**
 * A transient message about something that happened out of view (a change
 * the server refused, a reconnect). Appears instantly, fades out when closed.
 * Danger notices are announced at once (role alert), the others politely.
 */
export function Notice({tone = 'neutral', title, description, action, onDismiss, closing, onClosed, onHold}: NoticeProps) {
  const t = tones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-state={closing ? 'closed' : 'open'}
      onAnimationEnd={closing ? onClosed : undefined}
      onPointerEnter={() => onHold?.(true)}
      onPointerLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={() => onHold?.(false)}
      className={cx(floating, 'pointer-events-auto flex items-start gap-2 p-3')}
    >
      <Icon icon={t.icon} className={cx(message.icon, t.text)}/>
      <div className={message.body}>
        <p className={message.title}>{title}</p>
        {description && <p className={message.description}>{description}</p>}
        {action && <div className={message.actions}>{action}</div>}
      </div>
      <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} className="-mt-1 -mr-1"/>
    </div>
  );
}
