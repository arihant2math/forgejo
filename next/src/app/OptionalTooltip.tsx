// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Tooltip, type TooltipProps} from '@primer/react';
import {createElement, type ReactElement} from 'react';

/**
 * Primer's Tooltip when there is something to say (why a button is disabled, what it does), else the trigger
 * alone: many buttons explain themselves only in some states (offline, read-only).
 */
export function OptionalTooltip({text, keybindingHint, direction, children}: {
  text: string | undefined | null | false;
  keybindingHint?: string | undefined;
  direction?: TooltipProps['direction'] | undefined;
  children: ReactElement;
}) {
  if (!text) return children;
  const props: TooltipProps = {text, children};
  if (keybindingHint) props.keybindingHint = keybindingHint;
  if (direction) props.direction = direction;
  return createElement(Tooltip, props);
}
