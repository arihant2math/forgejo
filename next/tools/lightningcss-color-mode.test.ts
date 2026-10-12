// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {transform} from 'lightningcss';
import {expect, test} from 'vitest';
import {dropAutoColorMode} from './lightningcss-color-mode.ts';

const run = (css: string) => transform({filename: 'x.css', code: Buffer.from(css), minify: true, visitor: dropAutoColorMode}).code.toString();

test('drops auto colour-mode selectors and the media blocks they leave empty', () => {
  expect(run(`[data-color-mode="light"][data-light-theme="light"],
[data-color-mode="auto"][data-light-theme="light"] { --a: 1px; }
@media (prefers-color-scheme: dark) { [data-color-mode][data-color-mode="auto"][data-dark-theme="light"] { --a: 1px; } }
@media (prefers-color-scheme: light) { [data-color-mode=auto][data-light-theme*=light] .x { --b: 1px } .keep { --c: 1px } }
[data-color-mode=dark] .y { --d: 1px }`)).toBe(
    '[data-color-mode=light][data-light-theme=light]{--a:1px}@media (prefers-color-scheme:light){.keep{--c:1px}}[data-color-mode=dark] .y{--d:1px}',
  );
});
