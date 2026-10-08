// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {LucideIcon} from 'lucide-react';
import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {symbolId} from './sprite.ts';

export type {LucideIcon};

const sizes = {sm: 'size-3.5', md: 'size-4', lg: 'size-8'} as const;

export interface IconProps {
  icon: LucideIcon;
  size?: keyof typeof sizes;
  className?: string;
}

/** A decorative lucide icon at one of the standard sizes (drawn from a sprite: sprite.ts). */
export function Icon({icon: Glyph, size = 'md', className}: IconProps) {
  const cls = cx(sizes[size], 'shrink-0', className);
  const id = symbolId(Glyph);
  if (id) return <svg aria-hidden className={cls}><use href={`#${id}`}/></svg>;
  return <Glyph aria-hidden className={cls} strokeWidth={1.75}/>;
}

/**
 * A meaningful icon (a status) named for assistive tech and on hover with a
 * native title: cheap enough for every row of a list, where a Tooltip per
 * cell would cost a mount per row scrolled into view.
 */
export function Hint({label, children}: {label: string; children: ReactNode}) {
  return <span role="img" aria-label={label} title={label} className="flex shrink-0">{children}</span>;
}
