// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// jsdom lacks a few browser APIs Primer, the router and the theme code use.

import {cleanup} from '@testing-library/react';
import {afterEach} from 'vitest';

const noop = () => undefined;
// jsdom declares some of these as undefined properties, so test the value, not `in`.
const missing = (obj: object, key: string) => typeof Reflect.get(obj, key) !== 'function';

if (typeof window !== 'undefined') {
  if (missing(window, 'matchMedia')) {
    Object.assign(window, {
      matchMedia: (query: string): MediaQueryList => ({
        matches: false, media: query, onchange: null, addEventListener: noop, removeEventListener: noop,
        addListener: noop, removeListener: noop, dispatchEvent: () => false,
      }),
    });
  }
  if (missing(globalThis, 'ResizeObserver')) {
    Object.assign(globalThis, {ResizeObserver: class {
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    }});
  }
  for (const method of ['scrollIntoView', 'hasPointerCapture', 'releasePointerCapture'] as const) {
    if (missing(Element.prototype, method)) Object.assign(Element.prototype, {[method]: () => false});
  }
  // Router scroll restoration and Primer's overlays scroll elements.
  if (missing(Element.prototype, 'scrollTo')) Object.assign(Element.prototype, {scrollTo: noop});
  // Primer's popover polyfill adopts a constructed stylesheet into the document and shadow roots.
  for (const prototype of [Document.prototype, ShadowRoot.prototype]) {
    if (!Array.isArray(Reflect.get(prototype, 'adoptedStyleSheets'))) {
      Object.defineProperty(prototype, 'adoptedStyleSheets', {configurable: true, writable: true, value: []});
    }
  }
  if (missing(CSSStyleSheet.prototype, 'replaceSync')) Object.assign(CSSStyleSheet.prototype, {replaceSync: noop});
  afterEach(() => {
    cleanup();
  });
}
