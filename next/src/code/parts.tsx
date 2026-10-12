// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixed line heights allow virtualization without measuring.
// Untrusted code and logs stay in text nodes; classes come from fixed tables.

import type {ComponentProps, ReactNode, Ref} from 'react';
import {clsx} from 'clsx';
import {Button} from '@primer/react';
import {SkeletonBox} from '@primer/react/experimental';
import {synClass} from './shiki.ts';

export interface TokenSpans {
  spans: Uint32Array;
  starts: Uint32Array;
}

/**
 * Calls fn for each token of a line (zero-based) of `length` characters with its range and classes ('' when plain).
 * Without highlighting, or past its spans, the line is one plain token.
 */
export function eachToken(hl: TokenSpans | null | undefined, line: number, length: number, fn: (from: number, to: number, cls: string) => void): void {
  let at = 0;
  const from = hl?.starts[line];
  const to = hl?.starts[line + 1];
  if (hl && from !== undefined && to !== undefined) {
    for (let k = from; k < to && at < length; k++) {
      const end = Math.min(length, at + (hl.spans[2 * k] ?? 0));
      fn(at, end, synClass(hl.spans[2 * k + 1] ?? 0));
      at = end;
    }
  }
  if (at < length) fn(at, length, '');
}

/** A range of a line [from, to), e.g. a search match. */
export interface Mark {
  from: number;
  to: number;
}

/** A highlighted line; `marks` (sorted, disjoint) wrap their text in <mark>, over the syntax colours. */
export function CodeTokens({text, hl, line, marks}: {text: string; hl?: TokenSpans | null | undefined; line: number; marks?: readonly Mark[] | undefined}) {
  if (!hl && !marks?.length) return text;
  const out: ReactNode[] = [];
  let m = 0;
  eachToken(hl, line, text.length, (from, to, cls) => {
    for (let a = from; a < to;) {
      while (marks && (marks[m]?.to ?? Infinity) <= a) m++;
      const mark = marks?.[m];
      const marked = mark !== undefined && mark.from <= a;
      const b = Math.min(to, marked ? mark.to : mark?.from ?? to);
      const part = cls ? <span key={out.length} className={cls}>{text.slice(a, b)}</span> : text.slice(a, b);
      out.push(marked ? <mark key={out.length} className="bg-attention-muted text-default">{part}</mark> : part);
      a = b;
    }
  });
  return out;
}

/** Replaces el's content with text-node spans; hl must cover its newline-split text. */
export function paintTokens(el: HTMLElement, hl: TokenSpans): void {
  const out = document.createDocumentFragment();
  el.textContent.split('\n').forEach((text, line) => {
    if (line > 0) out.append('\n');
    eachToken(hl, line, text.length, (from, to, cls) => {
      if (!cls) {
        out.append(text.slice(from, to));
        return;
      }
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text.slice(from, to);
      out.append(span);
    });
  });
  el.replaceChildren(out);
}

export type LineTone = 'add' | 'del' | 'hunk' | 'none';

const lineTone = {add: 'bg-diff-addition-line text-default', del: 'bg-diff-deletion-line text-default', hunk: 'bg-accent-muted text-muted', none: 'text-default'} as const;
const gutterTone = {add: 'bg-diff-addition-word', del: 'bg-diff-deletion-word', hunk: 'bg-accent-muted', none: 'bg-default'} as const;

export interface CodeLineProps {
  gutter: ReactNode;
  tone?: LineTone | undefined;
  /** The line under the keyboard cursor or linked to (#L12): an accent edge (drawn on the gutter, over the text). */
  active?: boolean | undefined;
  /** A line a link names (#L12, #L12-L20): tinted, gutter and text. */
  linked?: boolean | undefined;
  /** After the text (a pending mark, a hunk's Expand). */
  trailing?: ReactNode;
  /** In the gutter, at its right edge (LineAction): on screen however long the line is. */
  action?: ReactNode;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  id?: string | undefined;
}

/** Wide lines scroll without wrapping; the sticky, positioned gutter paints over text without z-index. */
export function CodeLine({gutter, tone = 'none', active, linked, trailing, action, children, ref, id}: CodeLineProps) {
  return (
    <div ref={ref} id={id} data-active={active ? '' : undefined} data-linked={linked ? '' : undefined}
      className={clsx('group flex w-max min-w-full items-center font-mono text-base contain-layout', tone === 'hunk' ? 'h-8' : 'h-line', linked ? 'bg-control-transparent-selected text-default' : lineTone[tone])}>
      {/* The cursor's edge is the gutter's own (sticky, it would cover an edge drawn on the row). */}
      <span data-active={active ? '' : undefined} className={clsx('row-cursor sticky left-0 flex shrink-0 items-center self-stretch', linked ? 'bg-control-transparent-selected' : gutterTone[tone])}>
        {gutter}
        {action && <span className="absolute inset-y-0 right-0 flex items-center">{action}</span>}
      </span>
      <span className="code-text pr-6 pl-4">{children}</span>
      {trailing}
    </div>
  );
}

/** Kept lightweight because virtualized diffs mount an action per visible line. */
export function LineAction({label, children = '+', ...props}: {label: string} & ComponentProps<typeof Button>) {
  return (
    <span className="invisible flex items-center group-hover:visible group-data-active:visible">
      {/* Mouse only: the keyboard comments with Enter on the line cursor (no tab stop per line). */}
      <Button type="button" size="small" variant="invisible" tabIndex={-1} aria-label={label} {...{...props}}>
        {children}
      </Button>
    </span>
  );
}

/** Zero renders empty; onPick's boolean indicates Shift+click range selection. */
export function LineNo({n, onPick}: {n: number; onPick?: ((n: number, range: boolean) => void) | undefined}) {
  const cls = 'w-gutter shrink-0 pr-2 text-right text-muted tabular-nums select-none';
  if (!onPick || n <= 0) return <span className={cls}>{n > 0 ? n : ''}</span>;
  return (
    <a href={`#L${String(n)}`} aria-label={`Line ${String(n)}`} className={clsx(cls, 'cursor-pointer hover:text-default')} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      onPick(n, e.shiftKey);
    }}>{n}</a>
  );
}

export function BlameCell({first, summary, meta, children}: {first: boolean; summary?: string | undefined; meta?: string | undefined; children?: ReactNode}) {
  return (
    <span className={clsx('flex w-blame-narrow shrink-0 items-center self-stretch gap-2 overflow-hidden border-r @xl:w-blame border-muted bg-muted px-2 font-sans text-base text-default', first && 'border-t')}>
      {first && <>
        <span className="min-w-0 flex-1 truncate">{children ?? summary}</span>
        {meta && <span className="shrink-0 text-sm text-muted tabular-nums">{meta}</span>}
      </>}
    </span>
  );
}

export function DiffStat({additions, deletions}: {additions: number; deletions: number}) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-sm tabular-nums">
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

export function CodeFileHeader({path, oldPath, status, stat, leading, children, ref}: {
  path: string;
  oldPath?: string | undefined;
  status?: ReactNode;
  stat?: ReactNode;
  /** Before the path (a collapse toggle). */
  leading?: ReactNode;
  /** Actions on the right. */
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const slash = path.lastIndexOf('/');
  const prefix = path.slice(0, slash + 1);
  const basename = path.slice(slash + 1);
  return (
    <div ref={ref} className="flex h-10 items-center gap-2 border-y border-default bg-muted px-4 text-base">
      {leading}
      <span className="flex min-w-0 items-center font-mono text-base font-semibold text-default" title={oldPath ? `${oldPath} → ${path}` : path}>
        {(oldPath !== undefined || prefix.length > 0) && <span className="min-w-0 truncate">{oldPath && <span className="text-muted">{oldPath} → </span>}{prefix}</span>}
        <span className="shrink-0">{basename}</span>
      </span>
      {status && <span className="shrink-0 text-sm text-muted">{status}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">{stat}{children}</span>
    </div>
  );
}


const SKELETON_LINES = ['h-3 w-48', 'h-3 w-64', 'h-3 w-40', 'h-3 w-72', 'h-3 w-56'] as const;

/** A code surface still loading: the file view, blame and diffs. */
export function CodeSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-busy>
      {SKELETON_LINES.map((c, i) => <SkeletonBox key={i} className={c}/>)}
    </div>
  );
}
