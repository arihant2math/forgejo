// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

import {afterEach, expect, test, vi} from 'vitest';
import {readJson, writeJson} from './storage.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test('JSON storage handles missing, corrupt, saved and removed values', () => {
  expect(readJson('test')).toBeUndefined();
  localStorage.setItem('test', '{broken');
  expect(readJson('test')).toBeUndefined();
  writeJson('test', {closed: ['alice']});
  expect(readJson('test')).toEqual({closed: ['alice']});
  writeJson('test', undefined);
  expect(localStorage.getItem('test')).toBeNull();
});

test('legacy readers validate non-JSON values without changing valid JSON', () => {
  const legacy = (raw: string) => raw === 'split:hide' ? raw : undefined;
  localStorage.setItem('test', 'split:hide');
  expect(readJson('test', legacy)).toBe('split:hide');
  localStorage.setItem('test', 'corrupt');
  expect(readJson('test', legacy)).toBeUndefined();
  writeJson('test', 'unified:show');
  expect(readJson('test', legacy)).toBe('unified:show');
});

test('blocked storage never throws', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readJson('test')).toBeUndefined();
  expect(() => writeJson('test', 1)).not.toThrow();
  expect(() => writeJson('test', undefined)).not.toThrow();
});
