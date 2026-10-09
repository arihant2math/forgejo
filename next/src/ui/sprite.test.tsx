// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render} from '@testing-library/react';
import {CircleDashed, Tag} from 'lucide-react';
import {expect, test} from 'vitest';
import {Icon} from './Icon.tsx';
import {iconNode, symbolId} from './sprite.ts';

test('lucide icons are drawn once into a sprite and used by reference', () => {
  // The shape of lucide's internals this relies on (pinned version).
  expect(iconNode(CircleDashed)?.length).toBe(8);
  const {container} = render(<><Icon icon={CircleDashed}/><Icon icon={CircleDashed} size="sm"/><Icon icon={Tag}/></>);
  const uses = [...container.querySelectorAll('svg > use')].map((u) => u.getAttribute('href'));
  expect(uses).toHaveLength(3);
  expect(uses[0]).toBe(uses[1]);
  expect(uses[0]).not.toBe(uses[2]);
  const symbol = document.getElementById(symbolId(CircleDashed) ?? 'x');
  expect(symbol?.localName).toBe('symbol');
  expect(symbol?.querySelectorAll('path')).toHaveLength(8);
  expect(symbol?.getAttribute('stroke')).toBe('currentColor');
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('svg')?.getAttribute('class')).toContain('size-4');
});
