// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lint fixture: the marked lines must be reported (lint/lint.test.ts).
// Excluded from `npm run lint` by eslint.config.ts.

import {Button, TextInput} from '@primer/react';
import * as Primer from '@primer/react';

export const raw = '#ff0000';
export const fn = 'rgb(0 0 0)';
// Fine: prose and data are not class lists.
export const prose = ['Fixes #123', '- [ ] task', 'Error: [object Object]', 'transition', 'order-1'];

const look = 'bg-danger-emphasis rounded-full';
const widths = ['w-64', 'w-[13px]'];
const extra = {className: 'bg-danger-emphasis'};

export function Bad({dynamic}: {dynamic: string}) {
  return (
    <div className="bg-[#fff] p-[13px] transition-all dark:bg-inset duration-300 [&>svg]:size-4 z-10 p-3.25 bg-accent/50 *:p-1 transition-colors brightness-75 bg-linear-45" style={{color: 'red', background: `var(--fgColor-danger)`}}>
      <Button className="bg-danger-emphasis px-1 ml-2 h-10">Restyled</Button>
      <Button className={look}>Via a const</Button>
      <Button className={dynamic}>Opaque</Button>
      <Button {...{className: 'bg-danger-emphasis'}}>Spread</Button>
      <Button {...extra}>Spread a variable</Button>
      <Button style={{order: 1}}>Styled</Button>
      <Primer.Button className="rounded-full">Namespace</Primer.Button>
      <TextInput className="inset-ring-2"/>
      {widths.map((w) => <div key={w} className={w}/>)}
    </div>
  );
}
