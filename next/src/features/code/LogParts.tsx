// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {ChevronDownIcon, ChevronRightIcon} from '@primer/octicons-react';
import {Button, Text} from '@primer/react';
import {clsx} from 'clsx';
import type {ReactNode} from 'react';
import type {AnsiSpan} from '../../code/ansi.ts';

const ANSI = ['', 'text-danger', 'text-success', 'text-attention', 'text-accent', 'text-done', 'text-syntax-entity', 'text-muted'];
/** ANSI is text, never HTML; colours follow the active Primer theme. */
export function AnsiText({spans}: {spans: readonly AnsiSpan[]}) {
  return spans.map((span, i) => span.color || span.bold ? <span key={i} className={clsx(ANSI[span.color], span.bold && 'font-semibold')}>{span.text}</span> : span.text);
}
export function LogLine({number, children}: {number: number; children: ReactNode}) {
  return <div className="flex h-line w-max min-w-full font-mono text-code text-default contain-layout">
    <span className="sticky left-0 w-gutter shrink-0 bg-default pr-2 text-right text-muted tabular-nums select-none">{number}</span>
    <span className="code-text pr-6 pl-4">{children}</span>
  </div>;
}
export function StepHeader({expanded, onToggle, mark, meta, children}: {expanded: boolean; onToggle: () => void; mark: ReactNode; meta?: ReactNode; children: ReactNode}) {
  return <div className="flex h-10 items-center gap-2 border-y border-muted bg-muted px-4">
    <Button type="button" size="small" variant="invisible" block alignContent="start"
      leadingVisual={expanded ? ChevronDownIcon : ChevronRightIcon}
      trailingAction={() => <span className="text-sm font-normal whitespace-nowrap text-muted tabular-nums">{meta}</span>}
      aria-expanded={expanded} onClick={onToggle}>
      <span className="flex min-w-0 items-center gap-2">{mark}<Text size="medium" weight="semibold" className="truncate">{children}</Text></span>
    </Button>
  </div>;
}
