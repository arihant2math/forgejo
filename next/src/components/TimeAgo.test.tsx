// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {fullDate} from '../app/time.ts';
import {TimeAgo} from './TimeAgo.tsx';

test('compact: cached short text in a <time> titled with the full date and its label', () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const {container} = render(<TimeAgo at={at} label="Updated" className="w-12"/>);
  const time = container.querySelector('time');
  expect(time?.getAttribute('datetime')).toBe(at);
  expect(time?.textContent).toBe('5m');
  expect(time?.title).toBe(`Updated ${fullDate(at)}`);
  expect(time?.className).toBe('w-12');
});

test('words: GitHub\'s relative-time element, which renders words in its shadow root and refreshes itself', async () => {
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  const {container} = render(<TimeAgo at={at} variant="words"/>);
  const el = container.querySelector('relative-time');
  expect(el?.getAttribute('datetime')).toBe(at);
  await vi.waitFor(() => { expect(el?.shadowRoot?.textContent).toBe('2 minutes ago'); });
  expect(el?.getAttribute('title')).not.toBe('');
});

test('words: older than 30 days reads as a date, like GitHub', async () => {
  const at = '2020-03-05T10:00:00Z';
  const {container} = render(<TimeAgo at={at} variant="words"/>);
  const el = container.querySelector('relative-time');
  await vi.waitFor(() => { expect(el?.shadowRoot?.textContent).toMatch(/^on Mar 5, 2020$/); });
});
