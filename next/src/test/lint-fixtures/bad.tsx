// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lint fixture: every line below must be reported (lint/lint.test.ts).
// Excluded from `npm run lint` by eslint.config.ts.

import {Dialog} from 'radix-ui';

export const raw = '#ff0000';
export const fn = 'rgb(0 0 0)';

export function Bad() {
  return (
    <div className="bg-[#fff] p-[13px] transition-all dark:bg-canvas duration-300 [&>svg]:size-4" style={{color: 'red'}}>
      <Dialog.Root/>
    </div>
  );
}
