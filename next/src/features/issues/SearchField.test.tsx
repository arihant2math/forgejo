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

test('keeps text typed after settling while the value catches up, and still follows outside changes', () => {
  vi.useFakeTimers();
  const props = {label: 'Search labels', onChange: () => undefined, onSettle: () => undefined};
  const {rerender} = render(<SearchField {...props} value=""/>);
  const input = screen.getByRole<HTMLInputElement>('searchbox', {name: 'Search labels'});
  fireEvent.change(input, {target: {value: 'bu'}});
  act(() => {
    vi.advanceTimersByTime(300);
  });
  fireEvent.change(input, {target: {value: 'bug'}});
  rerender(<SearchField {...props} value="bu"/>);
  expect(input.value).toBe('bug');
  rerender(<SearchField {...props} value=""/>);
  expect(input.value).toBe('');
  rerender(<SearchField {...props} value="bu"/>);
  expect(input.value).toBe('bu');
});

test('a value that already matched at settle time leaves no marker, so leaving and coming back still resyncs', () => {
  vi.useFakeTimers();
  const props = {label: 'Search titles', onChange: () => undefined, onSettle: () => undefined};
  const {rerender} = render(<SearchField {...props} value=""/>);
  const input = screen.getByRole<HTMLInputElement>('searchbox', {name: 'Search titles'});
  fireEvent.change(input, {target: {value: 'bug'}});
  rerender(<SearchField {...props} value="bug"/>);
  act(() => {
    vi.advanceTimersByTime(300);
  });
  rerender(<SearchField {...props} value=""/>);
  expect(input.value).toBe('');
  rerender(<SearchField {...props} value="bug"/>);
  expect(input.value).toBe('bug');
});

test('a settled text with a trailing space keeps typing when its trimmed value arrives', () => {
  vi.useFakeTimers();
  const props = {label: 'Search labels', onChange: () => undefined, onSettle: () => undefined};
  const {rerender} = render(<SearchField {...props} value=""/>);
  const input = screen.getByRole<HTMLInputElement>('searchbox', {name: 'Search labels'});
  fireEvent.change(input, {target: {value: 'bug '}});
  act(() => {
    vi.advanceTimersByTime(300);
  });
  fireEvent.change(input, {target: {value: 'bug f'}});
  rerender(<SearchField {...props} value="bug"/>);
  expect(input.value).toBe('bug f');
});

test('a marker is consumed by the next value change, so revisiting an old value later follows it', () => {
  vi.useFakeTimers();
  const props = {label: 'Search labels', onChange: () => undefined, onSettle: () => undefined};
  const {rerender} = render(<SearchField {...props} value="bug"/>);
  const input = screen.getByRole<HTMLInputElement>('searchbox', {name: 'Search labels'});
  fireEvent.change(input, {target: {value: 'bugs'}});
  act(() => {
    vi.advanceTimersByTime(300);
  });
  rerender(<SearchField {...props} value="bugs"/>);
  rerender(<SearchField {...props} value=""/>);
  expect(input.value).toBe('');
  rerender(<SearchField {...props} value="bugs"/>);
  expect(input.value).toBe('bugs');
});
