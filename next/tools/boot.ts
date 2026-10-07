// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Modules (relative to next/) that the boot route renders: the shell plugin
 * modulepreloads their chunks and tools/budget.ts counts them and checks that
 * they are preloaded.
 */
export const BOOT_ROUTES = ['src/features/home/Home.tsx'];
