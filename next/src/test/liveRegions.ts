// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Primer announces through @primer/live-region-element: each <live-region> throttles its queue with
// window.setTimeout, and nothing cancels those timers when a test ends or its jsdom is torn down. A timer
// that fires after teardown throws "window is not defined" as an unhandled error and fails the run.
// Track every region that announces, and clear (cancel its queue and timer) and remove it after each test.

interface LiveRegion extends HTMLElement {
  announce: (...args: unknown[]) => unknown;
  clear: () => void;
}

const regions = new Set<LiveRegion>();

const isLiveRegion = (element: Element): element is LiveRegion =>
  typeof Reflect.get(element, 'clear') === 'function';

/** Record each <live-region> that announces, including ones a test later detaches (e.g. inside a dialog). */
export function trackLiveRegions(): void {
  void customElements.whenDefined('live-region').then((constructor) => {
    const prototype = constructor.prototype as LiveRegion;
    const announce = prototype.announce;
    prototype.announce = function (this: LiveRegion, ...args: unknown[]) {
      regions.add(this);
      return announce.apply(this, args);
    };
  });
}

/** Cancel every pending announcement and remove the regions, so no Primer timer outlives the test. */
export function settleLiveRegions(): void {
  for (const element of document.querySelectorAll('live-region')) {
    if (isLiveRegion(element)) regions.add(element);
  }
  for (const region of regions) {
    region.clear();
    region.remove();
  }
  regions.clear();
}
