// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Feature-level CSS would bypass the centralized styling and compilation path.

import {readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {expect, test} from 'vitest';

const src = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

test('CSS files only in src/styles, src/dev and the lint fixtures', () => {
  const css = files(src).filter((f) => f.endsWith('.css')).map((f) => relative(src, f));
  expect(css.filter((f) => !/^(?:styles|dev|test\/lint-fixtures)\//.test(f))).toEqual([]);
  expect(css).toContain('styles/tokens.css');
});
