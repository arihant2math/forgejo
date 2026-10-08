// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CircleAlert, CloudOff, Info, TriangleAlert} from 'lucide-react';
import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';

const tones = {
  neutral: {icon: Info, look: 'border-border bg-canvas', text: 'text-fg-muted'},
  offline: {icon: CloudOff, look: 'border-border bg-canvas', text: 'text-fg-muted'},
  warning: {icon: TriangleAlert, look: 'border-border bg-warning-subtle', text: 'text-warning'},
  danger: {icon: CircleAlert, look: 'border-border bg-danger-subtle', text: 'text-danger'},
} as const satisfies Record<string, {icon: LucideIcon; look: string; text: string}>;

export type CalloutTone = keyof typeof tones;

export interface CalloutProps {
  tone?: CalloutTone | undefined;
  title: string;
  children?: ReactNode;
  /** Small buttons, after the text. */
  actions?: ReactNode;
}

/**
 * An inline message in the page's flow (not floating, unlike Notice): an
 * edit's conflict, a change of yours that overrode someone's, why something
 * is not available offline.
 */
export function Callout({tone = 'neutral', title, children, actions}: CalloutProps) {
  const t = tones[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-md border px-3 py-2', t.look)}>
      <Icon icon={t.icon} className={cx('mt-0.5', t.text)}/>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-base font-medium text-fg">{title}</p>
        {children && <div className="text-sm text-fg-muted">{children}</div>}
        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </div>
  );
}
