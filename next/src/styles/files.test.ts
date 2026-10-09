// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

// Stylesheets live in src/styles (the app) and src/dev (dev-only pages). A
// feature-level .css file would be a second, unreviewed styling path next to
// the primitives (and app.css would not see it).

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
