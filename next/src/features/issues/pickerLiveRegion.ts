// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * SelectPanel's announcements lazily create @primer/live-region-element, whose
 * constructor builds its shadow template with innerHTML. Trusted Types blocks
 * that assignment (and leaves an element without its announcement methods).
 * Prepare the same two text containers in an inert document before upgrading:
 * Primer sees the existing shadow root and keeps its normal announcement queue.
 * No HTML parsing, permissive policy, or global prototype patches are needed.
 */
export function ensurePickerLiveRegion(): void {
  if (document.querySelector('live-region')) return;
  const inert = document.implementation.createHTMLDocument('');
  const region = inert.createElement('live-region');
  region.className = 'sr-only';
  const shadow = region.attachShadow({mode: 'open'});
  for (const politeness of ['polite', 'assertive']) {
    const container = inert.createElement('div');
    container.id = politeness;
    container.setAttribute('aria-live', politeness);
    container.setAttribute('aria-atomic', 'true');
    shadow.append(container);
  }
  document.adoptNode(region);
  customElements.upgrade(region);
  document.body.append(region);
}
