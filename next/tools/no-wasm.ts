// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Stands in for shiki/wasm (600 KB of inlined Oniguruma): the CSP has no 'wasm-unsafe-eval', so the app and
// Pierre only use Shiki's JavaScript regex engine.

export default function wasm(): never {
  throw new Error('Shiki\'s WASM engine cannot run under this page\'s CSP');
}
