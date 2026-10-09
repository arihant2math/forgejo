// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// History: the commits of a ref (optionally of one path), 50 per page, and
// one commit with its diff against its first parent. Commit lists come from
// API v1 by full SHA (cached: a page seen once is there offline); the diff
// from B9 (cached, parsed and highlighted in the worker).

import {GitCommitHorizontal, History} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import {type RefKind, type Resolved, resolveRef, shortSha} from '../../code/refs.ts';
import type {DiffFile} from '../../code/diff.ts';
import {CodeSource, type CommitInfo, NotCached} from '../../code/source.ts';
import {Avatar, Button, Code, EmptyState, Icon, TextLink} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {DiffView} from './DiffView.tsx';
import {type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {Ago, commitRow, Sha, summary} from './bits.tsx';
import {CodeLink, useCodeRows} from './nav.tsx';
import {RowList} from './RowList.tsx';
import {Unloaded} from './states.tsx';

export const CommitsView = observer(function CommitsView(props: CodeViewProps & {kind: RefKind | undefined; rest: string[]}) {
  const pool = usePool();
  const r = resolveRef(refTable(pool, props.repoId), props.kind, props.rest);
  const title = r ? <>History of <span className="font-mono">{r.path || (r.kind === 'commit' ? shortSha(r.sha) : r.ref)}</span></> : 'History';
  return (
    <CodeFrame view={props} title={title}>
      {(scroller) => (r ?
        <Commits {...props} at={r} scroller={scroller}/> :
        <EmptyState icon={History} title="Branch or tag not found" description="It does not exist, was deleted, or is not on this device."/>)}
    </CodeFrame>
  );
});

interface Pages {
  commits: CommitInfo[];
  /** Pages loaded. */
  pages: number;
  done: boolean;
  loading: boolean;
  /** The next page could not be loaded (offline: not on this device). */
  failed: Exclude<Loaded<never>, {state: 'ready'}> | undefined;
}

/** The pages of a history, one at a time (each from memory, IndexedDB or the server). */
function useCommitPages(repoId: number, sha: string, path: string) {
  const src = useSource();
  const [s, setS] = useState<Pages>({commits: [], pages: 0, done: false, loading: false, failed: undefined});
  const at = useRef({pages: 0, busy: false, done: false});
  const more = useCallback(() => {
    const st = at.current;
    if (st.busy || st.done) return;
    st.busy = true;
    const page = st.pages + 1;
    setS((p) => ({...p, loading: true}));
    src.commits(repoId, sha, page, path).then((list) => {
      st.busy = false;
      st.pages = page;
      st.done = list.length < 50;
      setS((p) => ({commits: [...p.commits, ...list], pages: page, done: st.done, loading: false, failed: undefined}));
    }, (err: unknown) => {
      st.busy = false;
      setS((p) => ({...p, loading: false, failed: err instanceof NotCached ? {state: 'offline'} : {state: 'error', message: err instanceof Error ? err.message : String(err), status: (err as {status?: number}).status ?? 0}}));
    });
  }, [src, repoId, sha, path]);
  useEffect(() => {
    more();
  }, [more]);
  return {s, more};
}

function Commits({owner, repo, repoId, at, scroller}: CodeViewProps & {at: Resolved; scroller: HTMLDivElement | null}) {
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const {s, more} = useCommitPages(repoId, at.sha, at.path);
  if (!s.commits.length) {
    if (s.failed) return <Unloaded loaded={s.failed} what="This history"/>;
    if (s.done) return <EmptyState icon={History} title="No commits"/>;
    return <Unloaded loaded={{state: 'loading'}} what="This history"/>;
  }
  return (
    <>
      <RowList items={s.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha}
        row={commitRow}
        onOpen={rows.onOpen} linkOf={rows.linkOf}/>
      {!s.done && (
        <div className="flex justify-center p-3">
          {s.failed ? <span className="text-sm text-fg-subtle">{s.failed.state === 'offline' ? 'Older commits are not on this device.' : 'Older commits could not be loaded.'}</span> :
            <Button size="sm" variant="ghost" disabled={s.loading} onClick={more}>Load older commits</Button>}
        </div>
      )}
    </>
  );
}

/** A diff between two commits, parsed in the worker (memory first). `base` "": the commit's first parent; `head` "": nothing yet. */
export function useDiff(repoId: number, base: string, head: string): Loaded<DiffFile[]> {
  const src = useSource();
  return useLoad(head ? CodeSource.diffKey(repoId, base, head) : undefined, () => src.peekDiff(repoId, base, head), () => src.diff(repoId, base, head));
}

export const CommitView = observer(function CommitView(props: CodeViewProps & {sha: string}) {
  const {owner, repo, repoId, sha} = props;
  const src = useSource();
  const info = useLoad(`commit:${String(repoId)}:${sha}`, () => src.peek<CommitInfo>(`commit:${String(repoId)}:${sha}`), () => src.commit(repoId, sha));
  const diff = useDiff(repoId, '', sha);
  const c = info.state === 'ready' ? info.value : undefined;
  return (
    <CodeFrame view={props} title={c ? summary(c.message) : shortSha(sha)}>
      {(scroller) => (
        <>
          <header className="flex flex-col gap-2 border-b border-border px-6 py-4">
            {c ? <CommitMeta owner={owner} repo={repo} c={c}/> : <p className="font-mono text-code text-fg-muted">{sha}</p>}
          </header>
          {diff.state === 'ready' ?
            <DiffView repoId={repoId} base="" head={sha} files={diff.value} scroller={scroller}/> :
            <Unloaded loaded={diff} what="This commit's changes"/>}
        </>
      )}
    </CodeFrame>
  );
});

function CommitMeta({owner, repo, c}: {owner: string; repo: string; c: CommitInfo}): ReactNode {
  const body = c.message.slice(summary(c.message).length).trim();
  return (
    <>
      {body && <pre className="font-mono text-code whitespace-pre-wrap text-fg-muted">{body}</pre>}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="flex items-center gap-1.5"><Avatar name={c.authorName} size="sm"/><span className="text-fg">{c.authorName}</span></span>
        <Ago at={c.date}/>
        <span className="flex items-center gap-1"><Icon icon={GitCommitHorizontal} size="sm"/><Code>{c.sha}</Code></span>
        {c.parents.map((p) => <span key={p}>parent <TextLink><CodeLink owner={owner} repo={repo} to={`commit/${p}`}><Sha sha={p}/></CodeLink></TextLink></span>)}
      </p>
    </>
  );
}
