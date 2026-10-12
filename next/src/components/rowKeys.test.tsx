// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {shortcuts} from '../app/shortcuts/index.ts';
import {ListRow} from './ListRow.tsx';
import {useRowKeys} from './rowKeys.ts';

let detach: () => void = () => undefined;
beforeEach(() => { detach = shortcuts.attach(window); });
afterEach(() => { detach(); });

function Rows({onOpen}: {onOpen: (name: string) => void}) {
  const keys = useRowKeys();
  const open = (name: string) => (e: {preventDefault: () => void}) => { e.preventDefault(); onOpen(name); };
  return <div {...keys}>
    <ListRow href="/a" onClick={open('a')}>a</ListRow>
    <ListRow>not a link</ListRow>
    <ListRow href="/b" onClick={open('b')}>b</ListRow>
    <ListRow href="/c" onClick={open('c')}>c</ListRow>
  </div>;
}

const press = (key: string) => { fireEvent.keyDown(document.activeElement ?? document.body, {key}); };

test('J and K move over the link rows, clamped at both ends, and Enter opens the focused one', () => {
  const onOpen = vi.fn();
  render(<Rows onOpen={onOpen}/>);
  const [a, b, c] = ['a', 'b', 'c'].map((name) => screen.getByRole('link', {name}));
  press('j');
  expect(document.activeElement).toBe(a);
  expect(a?.hasAttribute('data-active')).toBe(true);
  press('j');
  expect(document.activeElement).toBe(b);
  expect(a?.hasAttribute('data-active')).toBe(false);
  press('j');
  press('j');
  expect(document.activeElement).toBe(c);
  press('k');
  expect(document.activeElement).toBe(b);
  press('Enter');
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('b');
  fireEvent.blur(b as HTMLElement);
  expect(b?.hasAttribute('data-active')).toBe(false);
});
