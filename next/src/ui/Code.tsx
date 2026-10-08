// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code surfaces (F7): file views, blame, diffs and job logs are built from
// these. Every line has the same fixed height (h-line), so lists of lines
// virtualize without measuring. Text is always rendered as text nodes
// (syntax and ANSI colours are classes chosen from fixed tables): file
// contents, file names and logs never reach an HTML sink.

import {Slot} from 'radix-ui';
import type {ReactElement, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';

/** Syntax classes by token class (workers/highlight.ts SYN): plain, keyword, string, comment, function, constant, parameter, punctuation, link. */
const SYN = ['', 'text-syn-keyword', 'text-syn-string', 'text-syn-comment', 'text-syn-function', 'text-syn-constant', 'text-syn-parameter', 'text-fg-muted', 'text-accent-fg'] as const;

/** ANSI colour slots (code/ansi.ts): default, red, green, yellow, blue, magenta, cyan, grey. */
const ANSI = ['', 'text-danger', 'text-success', 'text-warning', 'text-accent-fg', 'text-done', 'text-syn-constant', 'text-fg-subtle'] as const;

export interface TokenSpans {
  spans: Uint32Array;
  starts: Uint32Array;
}

/**
 * One line's text with its syntax highlighting: `hl` holds (length, class)
 * pairs per line (line `line` of it); without it the text is plain.
 */
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
  // Text beyond the highlighted length (should not happen): plain.
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A log line's ANSI spans (code/ansi.ts). */
export function AnsiText({spans}: {spans: readonly {text: string; color: number; bold: boolean}[]}) {
  return spans.map((s, i) => (s.color || s.bold ? <span key={i} className={cx(ANSI[s.color], s.bold && 'font-semibold')}>{s.text}</span> : s.text));
}

export type LineTone = 'add' | 'del' | 'hunk' | 'none';

const lineTone = {add: 'bg-diff-add text-fg', del: 'bg-diff-del text-fg', hunk: 'bg-accent-subtle text-fg-muted', none: 'text-fg'} as const;
const gutterTone = {add: 'bg-diff-add-strong', del: 'bg-diff-del-strong', hunk: 'bg-accent-subtle', none: 'bg-surface'} as const;

export interface CodeLineProps {
  /** The gutter: line numbers (LineNo), a blame cell, … */
  gutter: ReactNode;
  tone?: LineTone | undefined;
  /** The line under the keyboard cursor or linked to (#L12): an accent edge. */
  active?: boolean | undefined;
  /** After the text (a comment button, a pending mark). */
  trailing?: ReactNode;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** For tests and for links to a line (#L12). */
  id?: string | undefined;
}

/**
 * One line of code: a fixed-height row (h-line). Wide lines widen the row
 * (w-max), so the page scrolls horizontally rather than wrapping; the gutter
 * scrolls with the text (a sticky gutter per line cost scroll frames).
 */
export function CodeLine({gutter, tone = 'none', active, trailing, children, ref, id}: CodeLineProps) {
  return (
    <div ref={ref} id={id} data-active={active ? '' : undefined}
      className={cx('group row-cursor flex h-line w-max min-w-full font-mono text-code contain-layout', lineTone[tone])}>
      <span className={cx('flex shrink-0', gutterTone[tone])}>{gutter}</span>
      <span className="code-text pr-6 pl-3">{children}</span>
      {trailing}
    </div>
  );
}

/**
 * A small "+" action at the end of a code line (comment on this line), shown
 * on the line's hover or focus. Deliberately plain — no tooltip machinery, no
 * SVG, not sticky: a diff mounts one per line as it scrolls (measured: those
 * cost frames). Its label is its accessible name and title.
 */
export function LineAction({label, onClick}: {label: string; onClick: () => void}) {
  return (
    <span className="invisible flex items-center group-hover:visible group-data-active:visible">
      {/* Mouse only: the keyboard comments with Enter on the line cursor (no tab stop per line). */}
      <button type="button" tabIndex={-1} aria-label={label} title={label} onClick={onClick}
        className="interactive flex size-control-sm items-center justify-center rounded-sm bg-accent text-fg-on-accent hover:bg-accent-hover">
        +
      </button>
    </span>
  );
}

/** A line number cell (empty for 0: the other side of an added or removed line). */
export function LineNo({n}: {n: number}) {
  return (
    <span className="w-gutter shrink-0 pr-2 text-right text-fg-subtle tabular-nums select-none">{n > 0 ? n : ''}</span>
  );
}

/** The blame column of a line: the commit's summary and age on the first line of a part, empty below it. */
export function BlameCell({first, summary, meta, children}: {first: boolean; summary?: string | undefined; meta?: string | undefined; children?: ReactNode}) {
  return (
    <span className={cx('flex w-blame shrink-0 items-center gap-2 overflow-hidden border-r border-border-subtle px-2 font-sans text-sm text-fg-muted', first && 'border-t')}>
      {first && <>
        <span className="min-w-0 flex-1 truncate">{children ?? summary}</span>
        {meta && <span className="shrink-0 text-fg-subtle tabular-nums">{meta}</span>}
      </>}
    </span>
  );
}

/**
 * A collapsible section header among code lines (a job step): one line high,
 * a status mark, the name, and its meta (a duration) on the right.
 */
export function StepHeader({expanded, onToggle, mark, meta, children}: {expanded: boolean; onToggle: () => void; mark: ReactNode; meta?: ReactNode; children: ReactNode}) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="interactive flex h-line w-full items-center gap-2 bg-canvas px-3 text-left font-sans text-sm text-fg hover:bg-hover">
      {mark}
      <span className="min-w-0 flex-1 truncate font-medium">{children}</span>
      {meta && <span className="text-fg-subtle tabular-nums">{meta}</span>}
    </button>
  );
}

/** Lines added and removed ("+12 −3"). */
export function DiffStat({additions, deletions}: {additions: number; deletions: number}) {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-sm tabular-nums">
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

/**
 * A file's header in a diff or a file view: its path (and the old one for a
 * rename), a status, the counts and actions. A fixed-height row (h-row).
 */
export function CodeFileHeader({path, oldPath, status, stat, leading, children, ref}: {
  path: string;
  oldPath?: string | undefined;
  /** "added", "deleted", "renamed", … (shown next to the path), or nothing. */
  status?: ReactNode;
  stat?: ReactNode;
  /** Before the path (a collapse toggle). */
  leading?: ReactNode;
  /** Actions on the right. */
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className="flex h-row items-center gap-2 border-y border-border bg-canvas px-3 text-base">
      {leading}
      <span className="min-w-0 truncate font-mono text-code text-fg" title={oldPath ? `${oldPath} → ${path}` : path}>
        {oldPath && <span className="text-fg-muted">{oldPath} → </span>}{path}
      </span>
      {status && <span className="shrink-0 text-sm text-fg-subtle">{status}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">{stat}{children}</span>
    </div>
  );
}

/** A tab bar of links (a repository's sections, a pull request's views). Put TabLink children in it. */
export function TabNav({label, children}: {label: string; children: ReactNode}) {
  return <nav aria-label={label} className="flex h-header shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4">{children}</nav>;
}

/** One tab: wraps a router <Link>, which sets aria-current="page" on the active route. */
export function TabLink({children}: {children: ReactElement}) {
  return (
    <Slot.Root className="interactive flex h-control shrink-0 items-center gap-1.5 rounded-md px-2.5 text-base whitespace-nowrap text-fg-muted hover:bg-hover hover:text-fg aria-[current=page]:bg-selected aria-[current=page]:text-fg">
      {children}
    </Slot.Root>
  );
}

