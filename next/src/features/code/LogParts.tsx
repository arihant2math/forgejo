// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {ChevronDownIcon, ChevronRightIcon} from '@primer/octicons-react';
import {Details, Text} from '@primer/react';
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
  return <div className="flex h-10 items-center gap-2 rounded-md border border-default bg-muted px-4">
    <Details open={expanded} className="w-full">
      <Details.Summary role="button" aria-expanded={expanded} onClick={(event) => { event.preventDefault(); onToggle(); }}>
        <span className="flex min-w-0 cursor-pointer items-center gap-2">
          {expanded ? <ChevronDownIcon size={16} className="shrink-0 text-muted"/> : <ChevronRightIcon size={16} className="shrink-0 text-muted"/>}
          <span className="flex shrink-0 items-center">{mark}</span>
          <Text size="medium" weight="semibold" className="min-w-0 flex-1 truncate">{children}</Text>
          <span className="shrink-0 text-sm font-normal whitespace-nowrap text-muted tabular-nums">{meta}</span>
        </span>
      </Details.Summary>
    </Details>
  </div>;
}
