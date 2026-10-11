// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon as OcticonType} from '@primer/octicons-react';
import type {ReactNode} from 'react';
import {cx} from './cx.ts';

/** An octicon component (transitional name: the app used lucide before Primer). */
export type LucideIcon = OcticonType;

const sizes = {sm: 12, md: 16, lg: 32} as const;

export interface IconProps {
  icon: OcticonType;
  size?: keyof typeof sizes;
  className?: string;
}

/** A decorative octicon at one of the standard sizes. */
export function Icon({icon: Glyph, size = 'md', className}: IconProps) {
  return <Glyph size={sizes[size]} className={cx('shrink-0', className)}/>;
}

/**
 * A meaningful icon (a status) named for assistive tech and on hover with a
 * native title: cheap enough for every row of a list, where a Tooltip per
 * cell would cost a mount per row scrolled into view.
 */
export function Hint({label, children}: {label: string; children: ReactNode}) {
  return <span role="img" aria-label={label} title={label} className="flex shrink-0">{children}</span>;
}
