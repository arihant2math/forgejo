// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one place for @pierre/diffs configuration: theme, highlighting limits, the worker pool and its Trusted Types policy.

import type {FileContents} from '@pierre/diffs';
import {WorkerPoolContext} from '@pierre/diffs/react';
import {getOrCreateWorkerPoolSingleton, type WorkerPoolManager} from '@pierre/diffs/worker';
import {type ReactNode, useCallback, useSyncExternalStore} from 'react';
import {useApp} from '../app/store.ts';
// Make the library worker the bundle entry: its package marks worker imports as side-effect-free.
// Importing it from a wrapper would let Rollup/Rolldown erase its message handler.
import workerURL from '@pierre/diffs/worker/worker.js?worker&url';
import {pierreWorker} from './pierreWorker.ts';
import './pierreTrust.ts';
import {LIMITS} from './shiki.ts';

const githubTheme = {light: 'github-light', dark: 'github-dark'} as const;
/** The code worker's limit (`code/shiki.ts`): longer lines stay plain in both renderers. */
const TOKENIZE_MAX_LINE = LIMITS.lineLength;

/** Never terminated: navigation keeps the warm workers and their AST cache. */
function workerPool(base: string): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {poolSize: 2, totalASTLRUCacheSize: 64, workerFactory: () => pierreWorker(base, workerURL, 'diffs-highlight')},
    highlighterOptions: {theme: githubTheme, preferredHighlighter: 'shiki-js', tokenizeMaxLineLength: TOKENIZE_MAX_LINE},
  });
}

/**
 * Provides the pool, created on first use. `plain` turns true when its workers fail: views then render
 * unhighlighted rather than fall back to Pierre's main-thread Shiki.
 */
export function PierreProvider({children}: {children: (plain: boolean) => ReactNode}) {
  const {config: {base}} = useApp();
  const pool = workerPool(base);
  const subscribe = useCallback((changed: () => void) => pool.subscribeToStatChanges(changed), [pool]);
  const plain = useSyncExternalStore(subscribe, () => !pool.isWorkingPool());
  return <WorkerPoolContext.Provider value={plain ? undefined : pool}>{children(plain)}</WorkerPoolContext.Provider>;
}

/** A file view's contents; the cache key is the blob SHA, so warm-ups and views share the pool's AST cache. */
export function fileContents(sha: string, name: string, contents: string, plain = false): FileContents {
  return {name, contents, cacheKey: `${sha}:${name}`, ...(plain ? {lang: 'text'} : {})};
}

/** Highlights a file at idle priority ahead of its view (no-op when the pool does not run). */
export function primeFile(base: string, sha: string, name: string, contents: string): void {
  const pool = workerPool(base);
  if (pool.isWorkingPool()) pool.primeFileHighlightCache(fileContents(sha, name, contents)).catch(() => undefined);
}

export const themeOptions = (dark: boolean) => ({theme: githubTheme, themeType: dark ? 'dark' : 'light'} as const);

// Slots live in a shadow root: inherit Primer's typography and functional tokens.
const primerCodeCSS = `:host {
  --diffs-font-family: var(--fontStack-monospace);
  --diffs-header-font-family: var(--fontStack-system);
  --diffs-font-size: var(--text-body-size-medium);
  --diffs-line-height: var(--spacing-line);
  --diffs-tab-size: var(--code-tab-size);
  --diffs-bg: var(--bgColor-default);
  --diffs-fg: var(--fgColor-default);
  --diffs-fg-number-override: var(--fgColor-muted);
  --diffs-bg-context-override: var(--bgColor-muted);
  --diffs-bg-context-gutter-override: var(--bgColor-muted);
  --diffs-bg-separator-override: var(--diffBlob-hunkLine-bgColor);
  --diffs-bg-selection-override: var(--bgColor-attention-muted);
  --diffs-bg-selection-number-override: var(--bgColor-attention-muted);
  --diffs-addition-color-override: var(--fgColor-success);
  --diffs-deletion-color-override: var(--fgColor-danger);
  --diffs-modified-color-override: var(--fgColor-accent);
  --diffs-bg-addition-emphasis-override: var(--diffBlob-additionWord-bgColor);
  --diffs-bg-deletion-emphasis-override: var(--diffBlob-deletionWord-bgColor);
  --diffs-gap-style: 1px solid var(--borderColor-muted);
}
[data-line-annotation] { font-family: var(--fontStack-system); font-size: var(--text-body-size-medium); line-height: 20px; color: var(--fgColor-default); }
[data-line][data-line-type="change-addition"] { --diffs-computed-diff-line-bg: var(--diffBlob-additionLine-bgColor); }
[data-line][data-line-type="change-deletion"] { --diffs-computed-diff-line-bg: var(--diffBlob-deletionLine-bgColor); }
[data-column-number][data-line-type="change-addition"] { --diffs-computed-diff-line-bg: var(--diffBlob-additionNum-bgColor); color: var(--diffBlob-additionNum-fgColor); }
[data-column-number][data-line-type="change-deletion"] { --diffs-computed-diff-line-bg: var(--diffBlob-deletionNum-bgColor); color: var(--diffBlob-deletionNum-fgColor); }
[data-diff-span] { border-radius: var(--borderRadius-medium); }
/* Line numbers stack above the gutter: keep the comment button clickable. */
[data-gutter-utility-slot] { z-index: 2; }
`;

export const renderOptions = {unsafeCSS: primerCodeCSS, tokenizeMaxLineLength: TOKENIZE_MAX_LINE, tokenizeMaxLength: 500_000} as const;
