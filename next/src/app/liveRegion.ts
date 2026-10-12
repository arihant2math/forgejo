// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Trusted Types blocks Primer's live-region constructor from parsing its shadow template, so the first
 * announcement of any SelectPanel, button or tree would fail. Boot prebuilds the region's text containers in an
 * inert document; Primer finds the region in the body and reuses its shadow root.
 */
export function ensureLiveRegion(): void {
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
