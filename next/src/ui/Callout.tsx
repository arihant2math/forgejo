// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon} from './Icon.tsx';
import {messageTones} from './Notice.tsx';
import {message} from './recipes.ts';

/** Inline messages tint their box with the tone (Notice floats on `raised` instead). */
const tints = {neutral: 'bg-canvas', warning: 'bg-warning-subtle', danger: 'bg-danger-subtle'} as const;

export type CalloutTone = keyof typeof tints;

export interface CalloutProps {
  tone?: CalloutTone | undefined;
  title: string;
  children?: ReactNode;
  /** Small buttons, after the text. */
  actions?: ReactNode;
}

/**
 * An inline message in the page's flow (not floating, unlike Notice): an
 * edit's conflict, a change of yours that overrode someone's. A note, not a
 * live region: what it is about is on the page already.
 */
export function Callout({tone = 'neutral', title, children, actions}: CalloutProps) {
  const t = messageTones[tone];
  return (
    <div role="note" className={cx('flex items-start gap-2 rounded-md border border-border px-3 py-2', tints[tone])}>
      <Icon icon={t.icon} className={cx(message.icon, t.text)}/>
      <div className={message.body}>
        <p className={message.title}>{title}</p>
        {children && <div className={message.description}>{children}</div>}
        {actions && <div className={message.actions}>{actions}</div>}
      </div>
    </div>
  );
}
