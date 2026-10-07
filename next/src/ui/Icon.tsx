// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {LucideIcon} from 'lucide-react';
import {cx} from './cx.ts';

export type {LucideIcon};

const sizes = {sm: 'size-3.5', md: 'size-4', lg: 'size-8'} as const;

export interface IconProps {
  icon: LucideIcon;
  size?: keyof typeof sizes;
  className?: string;
}

/** A decorative lucide icon at one of the standard sizes. */
export function Icon({icon: Glyph, size = 'md', className}: IconProps) {
  return <Glyph aria-hidden className={cx(sizes[size], 'shrink-0', className)} strokeWidth={1.75}/>;
}
