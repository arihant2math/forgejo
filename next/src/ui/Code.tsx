// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code surfaces (F7): file views, blame, diffs and job logs are built from
// these. Every line has the same fixed height (h-line), so lists of lines
// virtualize without measuring. Text is always rendered as text nodes
// (syntax and ANSI colours are classes chosen from fixed tables): file
// contents, file names and logs never reach an HTML sink.

import {Slot} from 'radix-ui';
import {Children, isValidElement, type ReactElement, type ReactNode, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {cx} from './cx.ts';
import {Tooltip} from './Tooltip.tsx';

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

/**
 * Highlights a code block of rendered markdown in place (a fenced block in an issue): its text becomes
 * text nodes inside spans of the same syntax classes as files and diffs (never markup). `hl` covers the
 * block's lines (the block's text split at "\n").
 */
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
  /** For tests and for links to a line (#L12). */
  id?: string | undefined;
}

/**
 * One line of code: a fixed-height row (h-line). Wide lines widen the row
 * (w-max), so the page scrolls horizontally rather than wrapping; the gutter
 * (line numbers, the diff's +/− tint) stays at the left edge while the text
 * scrolls under it (sticky; positioned, so it paints over the text without a
 * z-index). Only the rows in view exist (virtualized), so few gutters stick.
 */
export function CodeLine({gutter, tone = 'none', active, linked, trailing, action, children, ref, id}: CodeLineProps) {
  return (
    <div ref={ref} id={id} data-active={active ? '' : undefined} data-linked={linked ? '' : undefined}
      className={cx('group flex h-line w-max min-w-full font-mono text-code contain-layout', linked ? 'bg-selected text-fg' : lineTone[tone])}>
      {/* The cursor's edge is the gutter's own (sticky, it would cover an edge drawn on the row). */}
      <span data-active={active ? '' : undefined} className={cx('row-cursor sticky left-0 flex shrink-0', linked ? 'bg-selected' : gutterTone[tone])}>
        {gutter}
        {action && <span className="absolute inset-y-0 right-0 flex items-center">{action}</span>}
      </span>
      <span className="code-text pr-6 pl-3">{children}</span>
      {trailing}
    </div>
  );
}

/**
 * A small "+" action in a code line's gutter (comment on this line: CodeLine's
 * `action`), shown on the line's hover or focus; the gutter is sticky, so it is
 * on screen however long the line (QA verify3: at the end of the text it went
 * off screen). Deliberately plain — no tooltip machinery, no SVG: a diff mounts
 * one per line as it scrolls (measured: those cost frames). Its label is its
 * accessible name and title.
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

/**
 * A line number cell (empty for 0: the other side of an added or removed line). With `onPick` it is a link to the
 * line (#L12): a click names the line, Shift+click a range from the line named before (GitHub, classic).
 */
export function LineNo({n, onPick}: {n: number; onPick?: ((n: number, range: boolean) => void) | undefined}) {
  const cls = 'w-gutter shrink-0 pr-2 text-right text-fg-subtle tabular-nums select-none';
  if (!onPick || n <= 0) return <span className={cls}>{n > 0 ? n : ''}</span>;
  return (
    <a href={`#L${String(n)}`} aria-label={`Line ${String(n)}`} className={cx(cls, 'cursor-pointer hover:text-fg')} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      onPick(n, e.shiftKey);
    }}>{n}</a>
  );
}

/** The blame column of a line: the commit's summary and age on the first line of a part, empty below it. */
export function BlameCell({first, summary, meta, children}: {first: boolean; summary?: string | undefined; meta?: string | undefined; children?: ReactNode}) {
  return (
    <span className={cx('flex w-blame-narrow shrink-0 items-center gap-2 overflow-hidden border-r @xl:w-blame border-border-subtle px-2 font-sans text-sm text-fg-muted', first && 'border-t')}>
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
  // Pinned to the pane's left edge (w-lines: as wide as the pane, not the longest line): a log scrolled sideways keeps
  // its steps' names in view.
  return (
    <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="interactive sticky left-0 flex h-line w-lines items-center gap-2 bg-canvas px-3 text-left font-sans text-sm text-fg hover:bg-hover">
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

/**
 * A tab bar of links (a repository's sections, a pull request's views). Put TabLink children in it. On a narrow
 * screen it scrolls sideways, and the current tab is scrolled into it (a page opened from a tab far right showed
 * the strip from its start, without the tab).
 *
 * With `more`, the tabs that do not fit go into an overflow menu instead (like GitHub's repository tabs):
 * `more(hidden)` renders that menu (always shown, last) for the tabs at the indices `hidden`, which the bar hides.
 * The current tab (aria-current="page") stays in the bar, in place of the last one that would fit.
 * Each child is one tab; a tab's width is measured while it is shown and remembered while it is hidden.
 */
export function TabNav({label, children, more}: {label: string; children: ReactNode; more?: ((hidden: number[]) => ReactNode) | undefined}) {
  const nav = useRef<HTMLElement>(null);
  const widths = useRef(new Map<string, number>());
  // The indices of the tabs in the bar (undefined: all of them).
  const [shown, setShown] = useState<readonly number[] | undefined>(undefined);
  const tabs = Children.toArray(children);
  const overflow = more !== undefined;
  const measure = useCallback(() => {
    const el = nav.current;
    if (!el || !overflow) return;
    // The bar's children: one slot per tab (data-tab: its key), the overflow menu last.
    const kids = [...el.children] as HTMLElement[];
    const slots = kids.filter((k) => k.dataset.tab !== undefined);
    for (const s of slots) if (!s.hidden) widths.current.set(s.dataset.tab ?? '', s.offsetWidth);
    const style = getComputedStyle(el);
    const room = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const moreWidth = kids.at(-1)?.dataset.tab === undefined ? kids.at(-1)?.offsetWidth ?? 0 : 0;
    const current = slots.findIndex((s) => s.querySelector('a[aria-current="page"]') !== null);
    const next = shownTabs(slots.map((s) => widths.current.get(s.dataset.tab ?? '')), room, parseFloat(style.columnGap) || 0, moreWidth, current);
    setShown((prev) => (prev?.join() === next?.join() ? prev : next));
  }, [overflow]);
  useLayoutEffect(() => {
    measure();
    const el = nav.current;
    const tab = el?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!el || !tab || el.scrollWidth <= el.clientWidth) return;
    const left = tab.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left - (el.clientWidth - tab.offsetWidth) / 2;
  });
  useEffect(() => {
    const el = nav.current;
    if (!el || !overflow) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [measure, overflow]);
  const isHidden = (i: number) => shown !== undefined && !shown.includes(i);
  return (
    <nav ref={nav} aria-label={label} className="flex h-header shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4">
      {more ? <>
        {tabs.map((t, i) => {
          const key = isValidElement(t) && t.key !== null ? t.key : String(i);
          return <div key={key} data-tab={key} hidden={isHidden(i)} className={isHidden(i) ? 'hidden' : 'flex shrink-0'}>{t}</div>;
        })}
        <div className="flex shrink-0">{more(tabs.map((_, i) => i).filter(isHidden))}</div>
      </> : children}
    </nav>
  );
}

/**
 * Which tabs (indices, in order) stay in a bar of `room` px with `gap` between items and the overflow menu
 * (`moreWidth`) last: the leading ones that fit and, always, the current tab (`current`; -1: none) in place of
 * the last ones that would fit (GitHub keeps the selected tab visible). undefined when all fit, or when the bar
 * is not laid out (no room, a width unknown or 0).
 */
export function shownTabs(widths: readonly (number | undefined)[], room: number, gap: number, moreWidth: number, current = -1): number[] | undefined {
  if (room <= 0 || widths.some((x) => !x)) return undefined;
  const w = (i: number) => (widths[i] ?? 0) + gap;
  if (widths.reduce<number>((sum, _, i) => sum + w(i), moreWidth) <= room) return undefined;
  const keep = current >= 0 && current < widths.length;
  let used = moreWidth + (keep ? w(current) : 0);
  const shown: number[] = [];
  for (let i = 0; i < widths.length; i++) {
    if (i === current) continue;
    if (used + w(i) > room) break;
    used += w(i);
    shown.push(i);
  }
  if (keep) shown.push(current);
  return shown.sort((a, b) => a - b);
}

/** One tab: wraps a router <Link>, which sets aria-current="page" on the active route (`tooltip`: a hint on hover). */
export function TabLink({children, tooltip}: {children: ReactElement; tooltip?: string | undefined}) {
  const tab = (
    <Slot.Root className="interactive flex h-control shrink-0 items-center gap-1.5 rounded-md px-2.5 text-base whitespace-nowrap text-fg-muted hover:bg-hover hover:text-fg aria-[current=page]:bg-selected aria-[current=page]:text-fg">
      {children}
    </Slot.Root>
  );
  return tooltip ? <Tooltip content={tooltip}>{tab}</Tooltip> : tab;
}

