// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one place for @pierre/diffs configuration: theme, grammars, highlighting limits, the worker pool and its Trusted
// Types policy. Theme, grammars, language resolution and limits are those of code/shiki.ts, so Pierre and the code
// worker highlight alike.

import {type FileContents, registerCustomLanguage, registerCustomTheme} from '@pierre/diffs';
import {WorkerPoolContext} from '@pierre/diffs/react';
import {getOrCreateWorkerPoolSingleton, type WorkerPoolManager} from '@pierre/diffs/worker';
import {type ReactNode, useCallback, useSyncExternalStore} from 'react';
import {useApp} from '../app/store.ts';
// Make the library worker the bundle entry: its package marks worker imports as side-effect-free.
// Importing it from a wrapper would let Rollup/Rolldown erase its message handler.
import workerURL from '@pierre/diffs/worker/worker.js?worker&url';
import {pierreWorker} from './pierreWorker.ts';
import './pierreTrust.ts';
import {pierreLang} from './pierrePatch.ts';
import {GRAMMARS, LANGS, LIMITS, THEME} from './shiki.ts';

const THEME_NAME = THEME.name ?? '';
// Registered in memory: offline, the pool starts without fetching a theme chunk.
registerCustomTheme(THEME_NAME, () => Promise.resolve(THEME));
for (const lang of LANGS) registerCustomLanguage(lang, GRAMMARS[lang]);

/** Never terminated: navigation keeps the warm workers and their AST cache. */
function workerPool(base: string): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {poolSize: 2, totalASTLRUCacheSize: 64, workerFactory: () => pierreWorker(base, workerURL, 'diffs-highlight')},
    highlighterOptions: {theme: THEME_NAME, preferredHighlighter: 'shiki-js', tokenizeMaxLineLength: LIMITS.lineLength},
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
  return {name, contents, cacheKey: `${sha}:${name}`, lang: plain || contents.length > LIMITS.chars ? 'text' : pierreLang(name)};
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Highlights a file at idle priority ahead of its view (no-op when the pool does not run or the view would not). */
export function primeFile(base: string, sha: string, name: string, contents: string): void {
  const file = fileContents(sha, name, contents);
  if (file.lang === 'text' || lineCount(contents) > LIMITS.lines) return;
  const pool = workerPool(base);
  if (pool.isWorkingPool()) pool.primeFileHighlightCache(file).catch(() => undefined);
}

// Slots live in a shadow root: inherit Primer's typography and functional tokens.
const primerCodeCSS = `:host {
  color-scheme: inherit;
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
/* Shiki writes the theme's bold inline; code weighs semibold, as in the app's own line renderer. */
[data-line] span[style*="font-weight:bold"] { font-weight: var(--base-text-weight-semibold) !important; }
/* Line numbers stack above the gutter: keep the comment button clickable. */
[data-gutter-utility-slot] { z-index: 2; }
`;

/** Options for every Pierre view. One theme for every colour mode: its colours are Primer's prettylights variables. */
export const renderOptions = {theme: THEME_NAME, unsafeCSS: primerCodeCSS, tokenizeMaxLineLength: LIMITS.lineLength, tokenizeMaxLength: LIMITS.lines} as const;
