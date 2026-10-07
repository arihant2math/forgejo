// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Class recipes shared by more than one primitive. Features never use these
// directly: they compose the primitives in this directory. Recipes never set a
// property that the primitive using them sets too (ui.test.tsx checks for
// conflicting utilities).

/** A raised panel: dialogs, and the base of floating surfaces. Add a shadow. */
export const surface = 'rounded-lg border border-border bg-raised text-fg';

/** A floating surface (menus, popovers, tooltips): appears instantly, fades and shrinks out. Add a z-* layer. */
export const floating = `${surface} origin-popper overflow-hidden shadow-popover data-[state=closed]:animate-exit-pop`;

/** One row in a menu or a command list. Add a text colour. */
export const menuItem =
  'interactive group flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-base outline-none ' +
  'select-none data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:text-fg-subtle';

/** Inline-flex control with a fixed height; used by Button, IconButton and Input. */
export const control = 'interactive inline-flex shrink-0 items-center rounded-md';

/** Heights per control size. */
export const controlHeight = {sm: 'h-control-sm', md: 'h-control'} as const;

export type ControlSize = keyof typeof controlHeight;
