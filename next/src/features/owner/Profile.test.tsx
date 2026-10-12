// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {renderToStaticMarkup} from 'react-dom/server';
import {expect, test, vi} from 'vitest';
import {ContributionHeatmap} from './ContributionHeatmap.tsx';

test('heatmap fills missing days and excludes contributions outside the displayed year', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  try {
    const html = renderToStaticMarkup(<ContributionHeatmap rows={[
      {timestamp: Date.parse('2026-10-12') / 1000, contributions: 4},
      {timestamp: Date.parse('2020-01-01') / 1000, contributions: 20},
    ]}/>);
    expect(html).toContain('4 contributions in the last year');
    expect(html).toContain('var(--contribution-default-bgColor-0)');
    expect(html).toContain('var(--contribution-default-bgColor-4)');
    expect(html).not.toContain('fillOpacity');
    expect(html).toContain('2026-10-12: 4 contributions');
    expect(html).toContain('2026-10-11: 0 contributions');
    expect(html).not.toContain('2020-01-01:');
    expect(html.match(/<rect /g)?.length).toBeGreaterThanOrEqual(365);
  } finally { vi.useRealTimers(); }
});
