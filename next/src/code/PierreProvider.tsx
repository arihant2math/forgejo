// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {WorkerPoolContextProvider, useWorkerPool} from '@pierre/diffs/react';
import {type ReactNode, useEffect, useState} from 'react';

export const githubTheme = {light: 'github-light', dark: 'github-dark'} as const;
const poolOptions = {
  poolSize: 2,
  totalASTLRUCacheSize: 64,
  workerFactory: () => new Worker(new URL('../workers/diffs.worker.ts', import.meta.url), {type: 'module'}),
};
const highlighterOptions = {theme: githubTheme, preferredHighlighter: 'shiki-js', tokenizeMaxLineLength: 400} as const;

/** One singleton pool, shared by all mounted file and review surfaces. */
export function PierreProvider({children}: {children: ReactNode}) {
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
export const primerCodeCSS = `:host { --diffs-font-family: var(--fontStack-monospace); --diffs-font-size: var(--text-code); --diffs-line-height: var(--spacing-line); }
[data-line-annotation] { font-family: var(--fontStack-system); color: var(--fgColor-default); }
`;
