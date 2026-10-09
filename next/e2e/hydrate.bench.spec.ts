// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The data-layer benchmark in Chromium (src/dev/bench): 10k and 50k issue
// summaries through bootstrap, persistence and hydration. The numbers are
// printed (and recorded in IMPLEMENTATION.md, F2); the limits are generous
// regression guards, several times the measured values.

import {expect, test} from '@playwright/test';

interface Result {
  n: number;
  repos: number;
  bootstrapMs: number;
  persistMs: number;
  hydrateGroupMs: number;
  hydrateAllMs: number;
  queryMs: number;
  deltaMs: number;
  deltaFlushMs: number;
  atoms: number;
}

test('hydrating 10k and 50k issue summaries (one repository), 40k over 200 repositories', async ({page}) => {
  test.setTimeout(180_000);
  await page.goto('/-/next/dev/hydrate?n=10000,50000,40000x200');
  const handle = await page.waitForFunction(() => window.__bench, undefined, {timeout: 170_000});
  const out = await handle.jsonValue() as Result[] | {error: string};
  if (!Array.isArray(out)) throw new Error(out.error);
  for (const r of out) console.log(JSON.stringify(r));
  const small = out.find((r) => r.repos === 200);
  if (!small) throw new Error('no 200-repository result');
  expect(small.persistMs).toBeLessThan(10000);
  expect(small.hydrateAllMs).toBeLessThan(5000);
  const big = out.find((r) => r.n === 50_000);
  if (!big) throw new Error('no 50k result');
  expect(big.atoms).toBe(0); // bulk loads create no observables; the one observed field's atom is gone after the observer
  expect(big.persistMs).toBeLessThan(15000);
  expect(big.hydrateGroupMs).toBeLessThan(5000);
  expect(big.hydrateAllMs).toBeLessThan(5000);
  expect(big.bootstrapMs).toBeLessThan(8000);
  expect(big.deltaMs).toBeLessThan(16);
  expect(big.queryMs).toBeLessThan(50);
  expect(big.deltaFlushMs).toBeLessThan(100);
});
