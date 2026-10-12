// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Regression for #277: a <live-region>'s throttle timer outlived its test and fired after jsdom teardown.
// The tests run in order: the first leaves announcements queued, the setup's afterEach must cancel them.

import {announce, type LiveRegionElement} from '@primer/live-region-element';
import {describe, expect, it} from 'vitest';

const THROTTLE_MS = 150; // @primer/live-region-element's default delay between announcements

let leftover: LiveRegionElement | null = null;
const live = () => document.querySelector<LiveRegionElement>('live-region');

describe('live regions between tests', () => {
  it('queues announcements behind the throttle', () => {
    void announce('first');
    void announce('second');
    void announce('third');
    leftover = live();
    expect(leftover?.getMessage()).toBe('first');
  });

  it('cancels and removes the previous test\'s live regions', async () => {
    expect(leftover).not.toBeNull();
    expect(live()).toBeNull();
    expect(leftover?.isConnected).toBe(false);
    // Unsettled, the queue would keep announcing "second" and "third" on its own timers.
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS * 3));
    expect(leftover?.getMessage()).toBe('first');
  });

  it('tracks regions that were detached before the test ended', () => {
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.setAttribute('open', '');
    void announce('one', {from: dialog});
    void announce('two', {from: dialog});
    leftover = dialog.querySelector<LiveRegionElement>('live-region');
    expect(leftover?.getMessage()).toBe('one');
    dialog.remove();
  });

  it('cancels a detached region\'s queue too', async () => {
    expect(leftover?.isConnected).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS * 2));
    expect(leftover?.getMessage()).toBe('one');
  });
});
