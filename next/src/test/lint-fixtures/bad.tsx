// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lint fixture: every line below must be reported (lint/lint.test.ts).
// Excluded from `npm run lint` by eslint.config.ts.

import {Dialog} from 'radix-ui';
import {Button} from '../../ui/index.ts';

export const raw = '#ff0000';
export const fn = 'rgb(0 0 0)';
export const issueRef = 'Fixes #123'; // fine: not a colour

export function Bad() {
  return (
    <div className="bg-[#fff] p-[13px] transition-all dark:bg-canvas duration-300 [&>svg]:size-4 z-10 p-3.25 bg-accent/50 *:p-1 transition-colors" style={{color: 'red'}}>
      <Dialog.Root/>
      <Button className="bg-danger px-1 ml-2">Restyled</Button>
    </div>
  );
}
