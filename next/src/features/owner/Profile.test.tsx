// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {ContributionHeatmap} from './ContributionHeatmap.tsx';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 12));
});
afterEach(() => { vi.useRealTimers(); });

test('heatmap fills missing days and excludes contributions outside the displayed year', () => {
  const html = renderToStaticMarkup(<ContributionHeatmap rows={[
    {timestamp: at(2026, 10, 12), contributions: 4},
    {timestamp: at(2020, 1, 1), contributions: 20},
  ]}/>);
  expect(html).toContain('4 contributions in the last year');
  expect(html).toContain('var(--contribution-default-bgColor-0)');
  expect(html).toContain('var(--contribution-default-bgColor-4)');
  expect(html).toContain('2026-10-12: 4 contributions');
  expect(html).toContain('2026-10-11: 0 contributions');
  expect(html).not.toContain('2020-01-01:');
  expect(html.match(/<title>/g)?.length).toBeGreaterThanOrEqual(365);
});

test('the server\'s 15-minute buckets of one local day add up in that day', () => {
  const html = renderToStaticMarkup(<ContributionHeatmap rows={[
    {timestamp: at(2026, 10, 10, 9), contributions: 2},
    {timestamp: at(2026, 10, 10, 9, 15), contributions: 3},
    {timestamp: at(2026, 10, 10, 23, 45), contributions: 1},
  ]}/>);
  expect(html).toContain('2026-10-10: 6 contributions');
  expect(html).toContain('6 contributions in the last year');
});

test('month and weekday labels and a Less–More legend, as on GitHub', () => {
  const html = renderToStaticMarkup(<ContributionHeatmap rows={[]}/>);
  for (const label of ['Mon', 'Wed', 'Fri', 'Jan', 'Jun', 'Oct', 'Less', 'More']) expect(html).toContain(`>${label}<`);
  expect(html.match(/>Nov</g)).toHaveLength(1);
});
