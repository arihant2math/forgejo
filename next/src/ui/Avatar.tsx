// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cx} from './cx.ts';

const sizes = {sm: 'size-4 text-xs', md: 'size-5 text-xs', lg: 'size-6 text-sm'} as const;

export type AvatarProps = {
  size?: keyof typeof sizes;
} & (
  | {
    /** Display name; its first letter is the fallback when there is no image. */
    name: string;
    src?: string | undefined;
    fromSplash?: never;
  }
  | {
    /** Boot shell only: show the initial the splash script stored (--splash-initial). */
    fromSplash: true;
    name?: never;
    src?: never;
  }
);

export function Avatar({size = 'md', ...props}: AvatarProps) {
  const cls = cx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-border-strong font-medium text-fg select-none', sizes[size]);
  if (props.fromSplash) return <span aria-hidden className={cx(cls, 'splash-initial')}/>;
  if (props.src) return <img src={props.src} alt={props.name} loading="lazy" decoding="async" className={cx(cls, 'object-cover')}/>;
  return <span role="img" aria-label={props.name} className={cls}>{initial(props.name)}</span>;
}

function initial(name: string): string {
  const [first] = name.trim();
  return first ? first.toUpperCase() : '?';
}
