// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Browser checks (F8: one suite, IMPLEMENTATION.md has the commands).
//
//   build    e2e/boot.spec.ts against the production build (vite preview)
//   dev      e2e/gallery.spec.ts and the hydration benchmark against the dev server
//   forgejo  e2e/forgejo/*.spec.ts against a real Forgejo with livesync serving next/dist
//            (NEXT_FORGEJO_URL; skipped without it). `next/tools/dev-forgejo.sh e2e pg|mysql|all`
//            starts a fresh Forgejo per database and runs it; e2e/lib/ holds the shared helpers.

import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    // Use a preinstalled Chromium when Playwright's own build is not downloaded
    // (e.g. PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium in the sandbox).
    ...(process.env.PLAYWRIGHT_CHROMIUM ? {launchOptions: {executablePath: process.env.PLAYWRIGHT_CHROMIUM}} : {}),
  },
  projects: [
    {name: 'build', testMatch: 'boot.spec.ts', use: {baseURL: 'http://127.0.0.1:4173'}},
    {name: 'dev', testMatch: ['gallery.spec.ts', 'hydrate.bench.spec.ts'], use: {baseURL: 'http://127.0.0.1:5173'}},
    // Against a real Forgejo serving this checkout's build. Depends on "build" when run with the servers
    // below: that server writes dist/, which Forgejo serves (ASSETS_DIR); dev-forgejo.sh e2e builds it
    // first and runs this project alone (NEXT_E2E_NO_SERVERS=1, --no-deps).
    // One worker: the files share the server's users and repositories, and timings are measured.
    // (A regular expression: a glob such as 'forgejo/**' also matches this checkout's own path, …/forgejo/next/e2e/….)
    {name: 'forgejo', testMatch: /\/e2e\/forgejo\/[^/]+\.spec\.ts$/, dependencies: ['build'], timeout: 180_000, workers: 1},
  ],
  // NEXT_E2E_NO_SERVERS=1: run only against what is already up (e.g. --project forgejo against a
  // Forgejo serving next/dist: the build server would rebuild dist under it).
  webServer: process.env.NEXT_E2E_NO_SERVERS ? [] : [
    // Always this checkout's fresh build: never test whatever already listens on the port.
    {command: 'npx vite build && npx vite preview --host 127.0.0.1', url: 'http://127.0.0.1:4173/-/next/', reuseExistingServer: false},
    {command: 'npx vite --host 127.0.0.1', url: 'http://127.0.0.1:5173/-/next/', reuseExistingServer: false},
  ],
});
