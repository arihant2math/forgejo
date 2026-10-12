// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, render, screen} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {lazyComponent} from './lazy.tsx';

afterEach(() => { vi.restoreAllMocks(); });

test('a component that failed to load offline loads once back online, without logging an error', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const load = vi.fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
    .mockResolvedValue(() => <p>Loaded</p>);
  const Lazy = lazyComponent(load);
  render(<Lazy/>);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText('Loaded')).toBeNull();
  online.mockReturnValue(true);
  await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
  expect(await screen.findByText('Loaded')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

test('a load that fails again once back online stays quiet; one that fails online is an error', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Lazy = lazyComponent(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
  render(<Lazy/>);
  await act(async () => { await Promise.resolve(); });
  online.mockReturnValue(true);
  await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); await Promise.resolve(); });
  expect(error).not.toHaveBeenCalled();
  const Broken = lazyComponent(() => Promise.reject(new Error('404')));
  render(<Broken/>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(error).toHaveBeenCalledWith('loading a chunk failed', expect.any(Error));
});
