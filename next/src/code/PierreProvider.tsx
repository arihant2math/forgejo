// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {WorkerPoolContextProvider, useWorkerPool} from '@pierre/diffs/react';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
import {useApp} from '../app/store.ts';
// Make the library worker the bundle entry: its package marks worker imports as side-effect-free.
// Importing it from a wrapper would let Rollup/Rolldown erase its message handler.
import workerURL from '@pierre/diffs/worker/worker.js?worker&url';
import {pierreWorker} from './pierreWorker.ts';

export const githubTheme = {light: 'github-light', dark: 'github-dark'} as const;

const highlighterOptions = {theme: githubTheme, preferredHighlighter: 'shiki-js', tokenizeMaxLineLength: 400} as const;

/** One singleton pool, shared by all mounted file and review surfaces. */
export function PierreProvider({children}: {children: ReactNode}) {
  const {config: {base}} = useApp();
  const poolOptions = useMemo(() => ({poolSize: 2, totalASTLRUCacheSize: 64,
    workerFactory: () => pierreWorker(base, workerURL, 'diffs-highlight'),
  }), [base]);
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>{children}</WorkerPoolContextProvider>;
}

/** Do not allow Pierre's main-thread Shiki fallback on a worker/CSP failure. */
export function WorkerReady({children, fallback}: {children: ReactNode; fallback: ReactNode}) {
  const pool = useWorkerPool();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!pool) return undefined;
    void pool.initialize().then(() => {
      if (active) {
        if (pool.isWorkingPool()) setReady(true);
        else setFailed(true);
      }
    }, () => {if (active) setFailed(true);});
    return () => {active = false;};
  }, [pool]);
  if (!pool || failed) return fallback;
  return ready ? children : <div aria-busy="true" aria-label="Preparing code view"/>;
}

// Slots live in a shadow root: inherit Primer's typography and functional tokens.
export const primerCodeCSS = `:host {
  --diffs-font-family: var(--fontStack-monospace);
  --diffs-header-font-family: var(--fontStack-system);
  --diffs-font-size: var(--text-body-size-medium);
  --diffs-line-height: var(--spacing-line);
  --diffs-bg: var(--bgColor-default);
  --diffs-fg: var(--fgColor-default);
  --diffs-fg-number-override: var(--fgColor-muted);
  --diffs-bg-context-override: var(--bgColor-muted);
  --diffs-bg-context-gutter-override: var(--bgColor-muted);
  --diffs-bg-separator-override: var(--bgColor-accent-muted);
  --diffs-addition-color-override: var(--fgColor-success);
  --diffs-deletion-color-override: var(--fgColor-danger);
  --diffs-modified-color-override: var(--fgColor-accent);
  --diffs-bg-addition-emphasis-override: var(--diffBlob-addition-word-bgColor);
  --diffs-bg-deletion-emphasis-override: var(--diffBlob-deletion-word-bgColor);
  --diffs-gap-style: 1px solid var(--borderColor-muted);
}
[data-line-annotation] { font-family: var(--fontStack-system); font-size: var(--text-body-size-medium); line-height: 20px; color: var(--fgColor-default); }
[data-line][data-line-type="change-addition"] { --diffs-computed-diff-line-bg: var(--diffBlob-addition-bgColor); }
[data-line][data-line-type="change-deletion"] { --diffs-computed-diff-line-bg: var(--diffBlob-deletion-bgColor); }
[data-column-number][data-line-type="change-addition"] { --diffs-computed-diff-line-bg: var(--diffBlob-addition-num-bgColor); color: var(--fgColor-muted); }
[data-column-number][data-line-type="change-deletion"] { --diffs-computed-diff-line-bg: var(--diffBlob-deletion-num-bgColor); color: var(--fgColor-muted); }
[data-diff-span] { border-radius: var(--borderRadius-medium); }
`;
