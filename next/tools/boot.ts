// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Modules relative to next/ whose chunks must be preloaded and counted in boot budgets. */
export const BOOT_ROUTES = ['src/features/home/Home.tsx'];

/** Assets the service worker caches on first use instead of at install: grammars, themes, the unused WASM engine, React's profiling build. */
export const ON_DEMAND = /^assets\/(?:lang|theme|wasm|vendor-react-dom-profiling)-/;
