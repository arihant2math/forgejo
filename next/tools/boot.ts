// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Modules relative to next/ whose chunks must be preloaded and counted in boot budgets. */
export const BOOT_ROUTES = ['src/features/home/Home.tsx'];

/**
 * Where the build puts what the service worker caches on first use instead of at install: grammars, themes, React's
 * profiling build (`chunkFileNames` in vite.config.ts). No other chunk name can produce this directory.
 */
export const ON_DEMAND_DIR = 'assets/lazy/';
export const ON_DEMAND = /^assets\/lazy\//;
