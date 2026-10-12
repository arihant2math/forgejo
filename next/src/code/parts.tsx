// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixed line heights allow virtualization without measuring.
// Untrusted code and logs stay in text nodes; classes come from fixed tables.

import type {ComponentProps, ReactNode, Ref} from 'react';
import {clsx} from 'clsx';
import {Button} from '@primer/react';

/** Indexed by workers/highlight.ts SYN. */
const SYN = ['', 'text-syntax-keyword', 'text-syntax-string', 'text-syntax-comment', 'text-syntax-entity', 'text-syntax-constant', 'text-syntax-variable', 'text-muted', 'text-accent'] as const;

/** Indexed by code/ansi.ts colour slots. */
const ANSI = ['', 'text-danger', 'text-success', 'text-attention', 'text-accent', 'text-done', 'text-syntax-constant', 'text-muted'] as const;

export interface TokenSpans {
  spans: Uint32Array;
  starts: Uint32Array;
}

/** hl uses (length, class) pairs; line is a zero-based index into starts. */
export function CodeTokens({text, hl, line}: {text: string; hl?: TokenSpans | null | undefined; line: number}) {
  if (!hl) return text;
  const from = hl.starts[line];
  const to = hl.starts[line + 1];
  if (from === undefined || to === undefined) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (let k = from; k < to; k++) {
    const len = hl.spans[2 * k] ?? 0;
    const cls = SYN[hl.spans[2 * k + 1] ?? 0] ?? '';
    const part = text.slice(at, at + len);
    at += len;
    out.push(cls ? <span key={k} className={cls}>{part}</span> : part);
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Replaces el's content with text-node spans; hl must cover its newline-split text. */
export function paintTokens(el: HTMLElement, hl: TokenSpans): void {
  const lines = el.textContent.split('\n');
  const out = document.createDocumentFragment();
  lines.forEach((text, line) => {
    if (line > 0) out.append('\n');
    const from = hl.starts[line];
    const to = hl.starts[line + 1];
    if (from === undefined || to === undefined) {
      out.append(text);
      return;
    }
    let at = 0;
    for (let k = from; k < to; k++) {
      const len = hl.spans[2 * k] ?? 0;
      const cls = SYN[hl.spans[2 * k + 1] ?? 0] ?? '';
      const part = text.slice(at, at + len);
      at += len;
      if (cls) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = part;
        out.append(span);
      } else out.append(part);
    }
    if (at < text.length) out.append(text.slice(at));
  });
  el.replaceChildren(out);
}

export function AnsiText({spans}: {spans: readonly {text: string; color: number; bold: boolean}[]}) {
  return spans.map((s, i) => (s.color || s.bold ? <span key={i} className={clsx(ANSI[s.color], s.bold && 'font-semibold')}>{s.text}</span> : s.text));
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

export function StepHeader({expanded, onToggle, mark, meta, children}: {expanded: boolean; onToggle: () => void; mark: ReactNode; meta?: ReactNode; children: ReactNode}) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="interactive flex h-line w-full items-center gap-2 bg-muted px-4 text-left font-sans text-base text-default hover:bg-control-transparent-hover">
      {mark}
      <span className="min-w-0 flex-1 truncate font-semibold">{children}</span>
      {meta && <span className="text-muted tabular-nums">{meta}</span>}
    </button>
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

