// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Finds elements whose class list sets the same property twice under the same
// variants (e.g. "text-fg text-danger", "z-popover z-tooltip"). Which one wins
// then depends on stylesheet order, which is how composed recipes go wrong.

import {splitClass} from '../../lint/eslint-plugin-tokens.ts';

const textSizes = new Set(['xs', 'sm', 'base', 'md', 'lg', 'xl']);

/** The property group a utility sets, or undefined when it is not tracked. */
function group(utility: string): string | undefined {
  const m = /^-?([a-z]+(?:-[xytrblse])?)(?:-(.+))?$/.exec(utility);
  if (!m) return undefined;
  const [, head = '', rest] = m;
  if (head === 'text') return rest && textSizes.has(rest) ? 'font-size' : 'color';
  if (head === 'border' || head.startsWith('border-')) {
    // border, border-b = width; border-<colour> = colour.
    return rest && !/^\d/.test(rest) ? 'border-color' : `border-width${head.slice(6)}`;
  }
  if (head === 'font') return rest && ['sans', 'mono'].includes(rest) ? 'font-family' : 'font-weight';
  const tracked = ['bg', 'rounded', 'z', 'h', 'w', 'size', 'min-w', 'max-w', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'gap', 'shadow', 'animate', 'opacity'];
  return tracked.includes(head) ? head : undefined;
}

export function classConflicts(root: ParentNode): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll('[class]')) {
    const seen = new Map<string, string>();
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) {
      const {variants, utility} = splitClass(cls);
      const g = group(utility);
      if (!g) continue;
      const key = `${variants.join(':')}|${g}`;
      const prev = seen.get(key);
      if (prev) problems.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">: "${prev}" and "${cls}" both set ${g}`);
      else seen.set(key, cls);
    }
  }
  return problems;
}
