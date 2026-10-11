// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {CSSProperties, ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {labelInk} from './ink.ts';
import {Tooltip} from './Tooltip.tsx';

const chip = 'inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-sm font-medium whitespace-nowrap tabular-nums';

const tones = {
  neutral: 'border border-border-strong text-fg-muted',
  accent: 'bg-accent-subtle text-accent-fg',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  done: 'bg-done-subtle text-done',
} as const;

export type BadgeTone = keyof typeof tones;

/** A small status or count chip; `round`: a pill (a count beside a heading, a topic). */
export function Badge({tone = 'neutral', round = false, children}: {tone?: BadgeTone; round?: boolean; children: ReactNode}) {
  return <span className={cx(chip, round ? 'rounded-full' : 'rounded-sm', tones[tone])}>{children}</span>;
}

/** An issue label: its own colour (server data) as a dot, the name in normal text colour. */
export function LabelChip({name, color}: {name: string; color: string}) {
  return (
    <span className={cx(chip, 'rounded-full border border-border-strong text-fg-muted')} style={labelColor(color)}>
      <LabelDot color={color}/>
      {name}
    </span>
  );
}

const inks = {dark: 'text-on-label-dark', light: 'text-on-label-light'} as const;

/**
 * A label filled with its own colour (the labels page, a label's form): the text in the ink that contrasts more
 * with that colour (ink.ts). An exclusive scoped label (`scope/value`) shows its scope lighter, before the value.
 * A colour that is not a hex value is the plain chip.
 */
export function LabelPill({name, color, scope}: {name: string; color: string; scope?: string | undefined}) {
  const ink = labelInk(color);
  if (!ink) return <LabelChip name={name} color={color}/>;
  const value = scope ? name.slice(scope.length + 1) : name;
  return (
    <span className={cx(chip, 'max-w-full rounded-full bg-label', inks[ink])} style={labelColor(color)}>
      {scope && <span className="font-normal">{scope} /</span>}
      <span className="truncate">{value}</span>
    </span>
  );
}

// Only hex colours (Forgejo stores labels' colours as #rgb / #rrggbb) or a colour token reach the style; anything else is neutral.
const labelColor = (color: string) => ({'--label-color': /^(?:#[\da-f]{3,8}|var\(--color-[a-z-]+\))$/i.test(color) ? color : 'var(--color-fg-subtle)'} as CSSProperties);

/** A label's colour as a small dot (pickers, filters). */
export function LabelDot({color}: {color: string}) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full bg-label" style={labelColor(color)}/>;
}

/** An icon in a label's colour (a status or priority shown by its scoped label). */
export function LabelIcon({icon, color, size = 'md'}: {icon: LucideIcon; color: string; size?: 'sm' | 'md'}) {
  return (
    <span className="flex shrink-0 text-label" style={labelColor(color)}>
      <Icon icon={icon} size={size}/>
    </span>
  );
}

/**
 * A chip that toggles (a reaction: its emoji and count). Pressed: the
 * viewer is among those counted (accent tint, aria-pressed).
 */
/** A toggle chip (a reaction): `tooltip` says on hover what the chip is about (who reacted), as the app's tooltips do. */
export function ChipButton({pressed, label, tooltip, onClick, disabled, children}: {
  pressed: boolean; label: string; tooltip?: string | undefined; onClick: () => void; disabled?: boolean | undefined; children: ReactNode;
}) {
  const button = (
    // aria-disabled, not disabled: who reacted stays reachable (focus, the tooltip) when you cannot react.
    <button type="button" aria-pressed={pressed} aria-label={label} aria-disabled={disabled} onClick={disabled ? undefined : onClick}
      // The same border either way: toggling never changes its width.
      className={cx(chip, 'interactive rounded-full border', pressed ? 'border-transparent bg-accent-subtle text-accent-fg' : 'border-border-strong text-fg-muted', !disabled && 'hover:bg-hover')}>
      {children}
    </button>
  );
  return <Tooltip content={tooltip ?? label}>{button}</Tooltip>;
}
