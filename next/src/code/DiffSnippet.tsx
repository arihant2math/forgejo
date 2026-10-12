// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code outside the code views (a review comment's hunk, a suggested change, a search hit) is highlighted by the
// same worker, loaded only once such code is on screen.

import {useEffect, useEffectEvent, useState} from 'react';
import {useApp} from '../app/store.ts';
import {ADD, DEL, type DiffFile, filePath} from './diff.ts';
import {CodeLine, CodeTokens, LineNo} from './parts.tsx';
import type * as SourceModule from './source.ts';
import type {CodeSource, Highlight} from './source.ts';

let source: typeof SourceModule | undefined;

/**
 * The highlighting of the content `key` names: undefined until the worker has it, null for plain. It is asked for
 * while the component is mounted (and dropped from the queue when it unmounts first).
 */
export function useSnippetHighlight(key: string | undefined, ask: (src: CodeSource, signal: AbortSignal) => Promise<Highlight | null>,
  peek: (src: CodeSource) => Highlight | null | undefined): Highlight | null | undefined {
  const app = useApp();
  const [got, setGot] = useState<{key: string; hl: Highlight | null}>();
  const loaded = source?.codeSource(app);
  const hl = key === undefined ? undefined : got?.key === key ? got.hl : loaded && peek(loaded);
  const missing = key !== undefined && hl === undefined;
  const request = useEffectEvent((src: CodeSource, signal: AbortSignal) => ask(src, signal));
  useEffect(() => {
    if (!missing || key === undefined) return undefined;
    const ctl = new AbortController();
    void import('./source.ts').then(async (m) => {
      source = m;
      const src = m.codeSource(app);
      if (!src || ctl.signal.aborted) return;
      const h = await request(src, ctl.signal);
      if (!ctl.signal.aborted) setGot({key, hl: h});
    }).catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [app, key, missing]);
  return hl;
}

function contentKey(f: DiffFile): string {
  return `${filePath(f)}\n${f.lines.map((l) => `${String(l.k)}${l.t}`).join('\n')}`;
}

/** A few diff lines with both line numbers, highlighted per side like a diff. */
export function DiffSnippet({file}: {file: DiffFile}) {
  const hl = useSnippetHighlight(contentKey(file), (src, signal) => src.diffSnippet(file, signal), (src) => src.peekDiffSnippet(file));
  return (
    <div className="overflow-x-auto rounded-md border border-muted">
      {file.lines.map((l, i) => (
        <CodeLine key={i} tone={l.k === ADD ? 'add' : l.k === DEL ? 'del' : 'none'}
          gutter={<><LineNo n={l.o}/><LineNo n={l.n}/><span className="inline-block w-3 text-muted select-none">{l.k === ADD ? '+' : l.k === DEL ? '−' : ' '}</span></>}>
          <CodeTokens text={l.t} hl={hl} line={i}/>
        </CodeLine>
      ))}
    </div>
  );
}
