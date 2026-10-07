// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cx} from './cx.ts';

const sizes = {sm: 'size-4 text-xs', md: 'size-5 text-xs', lg: 'size-6 text-sm'} as const;

export interface AvatarProps {
  /** Display name; its first letter is the fallback when there is no image. */
  name: string;
  src?: string | undefined;
  size?: keyof typeof sizes;
  className?: string;
}

export function Avatar({name, src, size = 'md', className}: AvatarProps) {
  const cls = cx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-selected font-medium text-fg-muted select-none', sizes[size], className);
  if (src) return <img src={src} alt={name} loading="lazy" decoding="async" className={cx(cls, 'object-cover')}/>;
  return <span role="img" aria-label={name} className={cls}>{initial(name)}</span>;
}

function initial(name: string): string {
  const [first] = name.trim();
  return first ? first.toUpperCase() : '?';
}
