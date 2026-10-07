// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Browser checks. F1: the boot shell against the production build (vite
// preview) and the primitive gallery against the dev server. F8 grows this
// into the full e2e suite driven from a Go test.

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
    {name: 'dev', testMatch: 'gallery.spec.ts', use: {baseURL: 'http://127.0.0.1:5173'}},
  ],
  webServer: [
    // Always this checkout's fresh build: never test whatever already listens on the port.
    {command: 'npx vite build && npx vite preview --host 127.0.0.1', url: 'http://127.0.0.1:4173/-/next/', reuseExistingServer: false},
    {command: 'npx vite --host 127.0.0.1', url: 'http://127.0.0.1:5173/-/next/', reuseExistingServer: false},
  ],
});
