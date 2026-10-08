// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Class recipes shared by more than one primitive. Features never use these
// directly: they compose the primitives in this directory. Recipes never set a
// property that the primitive using them sets too (ui.test.tsx checks for
// conflicting utilities).

/** A raised panel: dialogs, and the base of floating surfaces. Add a shadow. */
export const surface = 'rounded-lg border border-border bg-raised text-fg';

/** A floating surface (menus, popovers, tooltips): appears instantly, fades and shrinks out. Add a z-* layer. */
export const floating = `${surface} origin-popper shadow-popover data-[state=closed]:animate-exit-pop`;

/** A small muted heading over a group of rows (menus, the palette, the sidebar, dialogs). */
export const sectionLabel = 'text-sm text-fg-subtle';

/** The layout of one row in a menu or a command list. */
export const menuRow = 'interactive group flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-base outline-none select-none';

/** One row in a Radix menu (data-highlighted / data-disabled are present only when on). Add a text colour. */
export const menuItem = `${menuRow} data-highlighted:bg-raised-hover data-disabled:pointer-events-none data-disabled:text-fg-subtle`;

/** The dimmed full-viewport layer under a dialog; it also centres the dialog near the top. */
export const overlay = 'fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto bg-overlay px-4 pt-24 pb-8 data-[state=closed]:animate-exit';

/** A dialog panel (add a max width). */
export const dialogPanel = `${surface} w-full shadow-dialog outline-none data-[state=closed]:animate-exit-pop`;

/** A centred square slot for a checkbox/radio indicator or a status icon. */
export const iconSlot = 'flex size-4 shrink-0 items-center justify-center';

/** Inline-flex control with a fixed height; used by Button, IconButton and Input. */
export const control = 'interactive inline-flex shrink-0 items-center rounded-md';

/** Heights per control size. */
export const controlHeight = {sm: 'h-control-sm', md: 'h-control'} as const;

export type ControlSize = keyof typeof controlHeight;
