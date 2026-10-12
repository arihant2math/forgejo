// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

import {afterEach, expect, test, vi} from 'vitest';
import {ensureLiveRegion} from './liveRegion.ts';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('live-region').forEach((region) => {region.remove();});
});

test('the boot-time region becomes Primer\'s live region, which announces without assigning innerHTML', async () => {
  document.querySelectorAll('live-region').forEach((region) => {region.remove();});
  const assignment = vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(() => {
    throw new TypeError('This document requires TrustedHTML assignment');
  });
  ensureLiveRegion();
  ensureLiveRegion();
  // Primer defines the element when it loads, which may be after boot.
  await import('@primer/react');
  const regions = document.querySelectorAll('live-region');
  expect(regions).toHaveLength(1);
  const region = regions[0];
  expect(region).toBeInstanceOf(customElements.get('live-region'));
  const announce: unknown = region && Reflect.get(region, 'announce');
  if (typeof announce !== 'function') throw new Error('Missing Primer announcement method');
  await announce.call(region, '<b>1 item</b>');
  const polite = region?.shadowRoot?.getElementById('polite');
  expect(polite?.getAttribute('aria-live')).toBe('polite');
  expect(polite?.getAttribute('aria-atomic')).toBe('true');
  expect(polite?.textContent).toBe('<b>1 item</b>');
  expect(polite?.querySelector('b')).toBeNull();
  expect(assignment).not.toHaveBeenCalled();
});
