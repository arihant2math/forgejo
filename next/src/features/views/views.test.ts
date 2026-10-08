// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {beforeEach, expect, test} from 'vitest';
import {canonical, isListPath, parseView, ViewStore} from './views.ts';

beforeEach(() => {
  localStorage.clear();
});

test('only list pages can be saved (a stored view never navigates elsewhere)', () => {
  expect(isListPath('/issues')).toBe(true);
  expect(isListPath('/acme/web/pulls')).toBe(true);
  expect(isListPath('/-/next/boards')).toBe(false);
  expect(isListPath('//evil.example/x/issues')).toBe(false);
  expect(isListPath('javascript:alert(1)')).toBe(false);
  expect(isListPath('/acme/web/issues/1')).toBe(false);
  expect(parseView({id: 'x', name: 'Mine', path: 'https://evil/a/b/issues', search: {}})).toBeUndefined();
});

test('search params are validated like the URL\'s', () => {
  const v = parseView({id: 'x', name: ' Bugs ', path: '/acme/web/issues', search: {labels: '1,-2,junk', sort: 'nope', group: 'status', evil: '<img>'}});
  expect(v).toEqual({id: 'x', name: 'Bugs', path: '/acme/web/issues', search: {labels: '1,-2', group: 'status'}});
  expect(parseView({id: 'y', name: 'Mine', path: '/issues', search: {type: 'assigned'}})?.search).toEqual({type: 'assigned'});
});

test('per user, shared through storage, saved/renamed/removed', () => {
  const a = new ViewStore(1);
  const v = a.save('Open bugs', '/acme/web/issues', {labels: '3', state: 'open'});
  expect(v).toBeDefined();
  expect(new ViewStore(2).views.length).toBe(0);
  const again = new ViewStore(1);
  expect(again.views.map((x) => x.name)).toEqual(['Open bugs']);
  again.rename(v?.id ?? '', 'Bugs');
  a.reload();
  expect(a.views.map((x) => x.name)).toEqual(['Bugs']);
  expect(a.match('/acme/web/issues', {state: 'open', labels: '3'})?.name).toBe('Bugs');
  a.remove(v?.id ?? '');
  expect(new ViewStore(1).views).toEqual([]);
});

test('canonical ignores key order and empty values', () => {
  expect(canonical({a: 1, b: undefined, c: ''})).toBe(canonical({a: 1}));
  expect(canonical({b: 2, a: 1})).toBe(canonical({a: 1, b: 2}));
});
