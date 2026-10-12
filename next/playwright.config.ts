// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM ? {launchOptions: {executablePath: process.env.PLAYWRIGHT_CHROMIUM}} : {}),
  },
  projects: [
    {name: 'build', testMatch: 'boot.spec.ts', use: {baseURL: 'http://127.0.0.1:4173'}},
    {name: 'dev', testMatch: ['gallery.spec.ts', 'hydrate.bench.spec.ts'], use: {baseURL: 'http://127.0.0.1:5173'}},
    // Depend on the build server unless using a Forgejo whose served dist/ is already built.
    // Files share users and repositories, and measure timings; run one worker.
    // A forgejo/** glob would also match the checkout path; use a regular expression.
    {name: 'forgejo', testMatch: /\/e2e\/forgejo\/[^/]+\.spec\.ts$/, dependencies: ['build'], timeout: 180_000, workers: 1},
  ],
  // Skip local servers when Forgejo serves dist/ to avoid rebuilding assets underneath it.
  webServer: process.env.NEXT_E2E_NO_SERVERS ? [] : [
    // Always this checkout's fresh build: never test whatever already listens on the port.
    {command: 'npx vite build && npx vite preview --host 127.0.0.1', url: 'http://127.0.0.1:4173/-/next/', reuseExistingServer: false},
    {command: 'npx vite --host 127.0.0.1', url: 'http://127.0.0.1:5173/-/next/', reuseExistingServer: false},
  ],
});
