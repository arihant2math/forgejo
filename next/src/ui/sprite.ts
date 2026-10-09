// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Icons as a sprite: every lucide glyph the page draws becomes one <symbol>
// in a hidden <svg> (created on first use), and each icon on screen is a
// two-element <svg><use href="#…"/></svg>. A lucide icon rendered inline is
// an <svg> with a dozen attributes plus one element per stroke (eight for a
// dashed circle); a list scrolling dozens of rows into view per frame spent
// most of its DOM time setting those attributes (F4 profile).
//
// The glyph's drawing is read from the lucide component itself (its render
// function hands lucide's base Icon the `icon` data: {node}); when that is
// not possible — no DOM (the build-time boot shell), or another lucide
// internals shape — Icon falls back to rendering the component inline.
// sprite.test.ts pins the shape for the lucide version in package.json.

import type {LucideIcon} from 'lucide-react';

type IconNode = [string, Record<string, string | number>][];

const ids = new WeakMap<LucideIcon, string | null>();
let host: SVGSVGElement | undefined;
let seq = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/** The drawing of a lucide icon (undefined if it cannot be read). */
export function iconNode(icon: LucideIcon): IconNode | undefined {
  try {
    const render = (icon as unknown as {render?: (props: object, ref: null) => {props?: {icon?: {node?: unknown}}}}).render;
    const node = render?.({}, null).props?.icon?.node;
    return Array.isArray(node) && node.every((n) => Array.isArray(n) && typeof n[0] === 'string') ? node as IconNode : undefined;
  } catch {
    return undefined;
  }
}

/** The id of the icon's <symbol> (created on first use), or null to render it inline. */
export function symbolId(icon: LucideIcon): string | null {
  let id = ids.get(icon);
  if (id !== undefined) return id;
  id = null;
  const node = typeof document === 'undefined' ? undefined : iconNode(icon);
  if (node) {
    if (!host?.isConnected) {
      host = svg('svg');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('width', '0');
      host.setAttribute('height', '0');
      host.style.position = 'absolute';
      document.body.append(host);
    }
    id = `icon-${String(++seq)}`;
    const symbol = svg('symbol');
    symbol.id = id;
    // Presentation attributes on the symbol reach every <use> of it (lucide's defaults, our stroke).
    for (const [k, v] of Object.entries({
      'viewBox': '0 0 24 24', 'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })) symbol.setAttribute(k, v);
    for (const [tag, attrs] of node) {
      const el = svg(tag as keyof SVGElementTagNameMap);
      for (const [k, v] of Object.entries(attrs)) if (k !== 'key') el.setAttribute(k, String(v));
      symbol.append(el);
    }
    host.append(symbol);
  }
  ids.set(icon, id);
  return id;
}
