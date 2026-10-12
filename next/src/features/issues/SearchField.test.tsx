// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {SearchField} from './SearchField.tsx';

afterEach(() => {
  vi.useRealTimers();
});

test('filters per keystroke, settles once typing pauses, and Escape clears', () => {
  vi.useFakeTimers();
  const onChange = vi.fn();
  const onSettle = vi.fn();
  render(<SearchField label="Search labels" value="" onChange={onChange} onSettle={onSettle}/>);
  const input = screen.getByRole<HTMLInputElement>('searchbox', {name: 'Search labels'});
  fireEvent.change(input, {target: {value: 'b'}});
  act(() => {
    vi.advanceTimersByTime(200);
  });
  fireEvent.change(input, {target: {value: 'bu'}});
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(onChange.mock.calls).toEqual([['b'], ['bu']]);
  expect(onSettle).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(onSettle.mock.calls).toEqual([['bu']]);
  fireEvent.keyDown(input, {key: 'Escape'});
  expect(input.value).toBe('');
  expect(onChange).toHaveBeenLastCalledWith('');
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(onSettle.mock.calls).toEqual([['bu'], ['']]);
});

test('follows a value changed from outside', () => {
  const props = {label: 'Search titles', onChange: () => undefined, onSettle: () => undefined};
  const {rerender} = render(<SearchField {...props} value="docs"/>);
  rerender(<SearchField {...props} value="bug"/>);
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('bug');
});
