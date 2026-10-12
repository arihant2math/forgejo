// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Commit pages are cached by full SHA for offline reads; commit diffs use the first parent.

import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {Avatar, Link as PrimerLink} from '@primer/react';

import {useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {codeSplat, type RefKind, type Resolved, resolveRef, shortSha} from '../../code/refs.ts';
import type {DiffFile} from '../../code/diff.ts';
import {CodeSource, type CommitInfo} from '../../code/source.ts';

import {usePool} from '../../app/store.ts';
import {reach} from '../../app/online.ts';
import {useSession} from '../../app/store.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {ChangedFiles, type DiffHandle, DiffView} from './DiffView.tsx';
import {DiffSettings, useDiffSettings} from './DiffSettings.tsx';
import {AUTO_RETRY_MS, failureOf, type LoadFailure, transientFailure, transientStatus} from '../../app/resource.ts';
import {type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {commitDay} from './bits.tsx';
import {Sha, summary} from '../../components/Sha.tsx';
import {CommitMessage, ContainedIn, linkedCommitRow} from './commitText.tsx';
import {CommitChecksSection, withChecks} from './commitChecks.tsx';
import {CodeLink, codeTo, useCodeRows} from './nav.tsx';
import {RowList} from './RowList.tsx';
import {Unloaded} from './states.tsx';
import {RefMenu} from './RefMenu.tsx';
import {CodePath} from './Src.tsx';
import {FileCodeIcon, GitCommitIcon, HistoryIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {EmptyState} from '../../components/EmptyState.tsx';

export const CommitsView = observer(function CommitsView(props: CodeViewProps & {kind: RefKind | undefined; rest: string[]}) {
  const pool = usePool();
  const r = resolveRef(refTable(pool, props.repoId), props.kind, props.rest);
  const title = r ? <CodePath owner={props.owner} repo={props.repo} at={r} view="commits" linkLast/> : 'Commits';
  const controls = r && <>
    <RefMenu owner={props.owner} repo={props.repo} repoId={props.repoId} at={r} view="commits"/>
    <RouterLinkButton variant="invisible" size="small" leadingVisual={FileCodeIcon} {...codeTo(props.owner, props.repo, codeSplat('src', r, r.path))}>Browse files</RouterLinkButton>
  </>;
  return (
    <CodeFrame view={props} title={title} controls={controls} docTitle={r?.path ? `History of ${r.path}` : 'Commits'} heading={r?.path ? `History of ${r.path}` : undefined}>
      {(scroller) => (r ?
        <Commits {...props} at={r} scroller={scroller}/> :
        <EmptyState icon={HistoryIcon} title="Branch or tag not found" description="It does not exist, was deleted, or is not on this device."/>)}
    </CodeFrame>
  );
});

interface Pages {
  commits: CommitInfo[];
  pages: number;
  done: boolean;
  loading: boolean;
  failed: (LoadFailure & {reload: () => void}) | undefined;
}

function useCommitPages(repoId: number, sha: string, path: string) {
  const src = useSource();
  const [s, setS] = useState<Pages>({commits: [], pages: 0, done: false, loading: false, failed: undefined});
  const at = useRef({pages: 0, busy: false, done: false, tries: 0, gone: false, connected: true});
  const connected = reach(useSession().data.status.connection) === 'online';
  const more = useCallback(function more() {
    const st = at.current;
    if (st.busy || st.done) return;
    st.busy = true;
    const page = st.pages + 1;
    setS((p) => ({...p, loading: true, failed: undefined}));
    src.commits(repoId, sha, page, path).then((list) => {
      st.busy = false;
      st.tries = 0;
      st.pages = page;
      st.done = list.length < 50;
      setS((p) => ({commits: [...p.commits, ...list], pages: page, done: st.done, loading: false, failed: undefined}));
    }, (err: unknown) => {
      st.busy = false;
      const pause = st.connected && transientFailure(err) ? AUTO_RETRY_MS[st.tries] : undefined;
      if (pause !== undefined) {
        st.tries++;
        setTimeout(() => {
          if (!st.gone) more();
        }, pause);
        return;
      }
      const retry = () => {
        st.tries = 0;
        more();
      };
      setS((p) => ({...p, loading: false, failed: {...failureOf(err), reload: retry}}));
    });
  }, [src, repoId, sha, path]);
  useEffect(() => {
    const st = at.current;
    st.gone = false;
    more();
    return () => {
      st.gone = true;
    };
  }, [more]);
  useEffect(() => {
    const st = at.current;
    const back = connected && !st.connected;
    st.connected = connected;
    if (back && s.failed?.state === 'offline') s.failed.reload();
  }, [connected, s.failed]);
  return {s, more, connected};
}

const Commits = observer(function Commits({owner, repo, repoId, at, scroller}: CodeViewProps & {at: Resolved; scroller: HTMLDivElement | null}) {
  const rows = useCodeRows<CommitInfo>(owner, repo, (c) => `commit/${c.sha}`);
  const {s, more, connected} = useCommitPages(repoId, at.sha, at.path);
  const repos = useMemo(() => ({base_repo_id: repoId, head_repo_id: repoId}), [repoId]);
  if (!s.commits.length) {
    if (s.failed) return <Unloaded loaded={s.failed} what="This history"/>;
    if (s.done) return <EmptyState icon={HistoryIcon} title="No commits"/>;
    return <Unloaded loaded={{state: 'loading'}} what="This history"/>;
  }
  return (
    <>
      <RowList items={s.commits} scroller={scroller} label="Commits" keyOf={(c) => c.sha} groupOf={commitDay} groupIcon={<GitCommitIcon size={16}/>}
        row={withChecks(linkedCommitRow(owner, repo), owner, repo, repos)}
        onOpen={rows.onOpen} linkOf={rows.linkOf}/>
      {!s.done && (
        <div className="flex justify-center p-4">
          {s.failed ? <span className="flex items-center gap-2 text-sm text-muted">{s.failed.state === 'offline' && !connected ? 'Older commits are not on this device.' : 'Older commits could not be loaded.'}{connected && (s.failed.state === 'offline' || transientStatus(s.failed.status)) && <Button variant="invisible" size="small" type="button" onClick={s.failed.reload}>Retry</Button>}</span> :
            <Button variant="invisible" size="small" type="button" disabled={s.loading} onClick={more}>Load older commits</Button>}
        </div>
      )}
    </>
  );
});

/** Empty base selects the first parent; empty head defers loading. */
export function useDiff(repoId: number, base: string, head: string): Loaded<DiffFile[]> {
  const src = useSource();
  const {whitespace} = useDiffSettings();
  return useLoad(head ? CodeSource.diffKey(repoId, base, head, whitespace) : undefined, () => src.peekDiff(repoId, base, head, whitespace), () => src.diff(repoId, base, head, whitespace));
}

export const CommitView = observer(function CommitView(props: CodeViewProps & {sha: string}) {
  const {owner, repo, repoId, sha} = props;
  const navigate = useNavigate();
  useShortcutScope('code');
  const back = () => { void navigate(codeTo(owner, repo, 'commits')); };
  useShortcut('code.back', back);
  useShortcut('code.up', back);
  const src = useSource();
  const info = useLoad(`commit:${String(repoId)}:${sha}`, () => src.peek<CommitInfo>(`commit:${String(repoId)}:${sha}`), () => src.commit(repoId, sha));
  const diff = useDiff(repoId, '', sha);
  const diffRef = useRef<DiffHandle>(null);
  const c = info.state === 'ready' ? info.value : undefined;
  if (info.state === 'error' && info.status === 404) {
    return (
      <CodeFrame view={props} title={shortSha(sha)}>
        {() => <Unloaded loaded={info} what="This commit" action={
          <RouterLinkButton leadingVisual={HistoryIcon} {...codeTo(owner, repo, "commits")}>All commits</RouterLinkButton>
        }/>}
      </CodeFrame>
    );
  }
  return (
    <CodeFrame view={props} title={c ? summary(c.message) : shortSha(sha)} controls={<><DiffSettings/>
      <RouterLinkButton variant="invisible" size="small" leadingVisual={FileCodeIcon} {...codeTo(owner, repo, `src/commit/${sha}`)}>Browse files</RouterLinkButton>
    </>}>
      {(scroller) => (
        <>
          {/* Pin commit metadata so horizontal diff scrolling cannot move it out of view. */}
          <header className="sticky left-0 flex w-view flex-col gap-2 border-b border-default px-6 py-4">
            {c ? <CommitMeta owner={owner} repo={repo} repoId={repoId} c={c}/> : <p className="font-mono text-code text-muted">{sha}</p>}
          </header>
          {diff.state === 'ready' ?
            <>
              <ChangedFiles files={diff.value} diff={diffRef}/>
              <DiffView ref={diffRef} repoId={repoId} base="" head={sha} files={diff.value} scroller={scroller}/>
            </> :
            <Unloaded loaded={diff} what="This commit's changes"/>}
        </>
      )}
    </CodeFrame>
  );
});

function CommitMeta({owner, repo, repoId, c}: {owner: string; repo: string; repoId: number; c: CommitInfo}): ReactNode {
  const body = c.message.slice(summary(c.message).length).trim();
  return (
    <>
      <h1 className="text-xl font-semibold text-default"><CommitMessage owner={owner} repo={repo} text={summary(c.message)}/></h1>
      {body && <pre className="font-mono text-code whitespace-pre-wrap text-muted"><CommitMessage owner={owner} repo={repo} text={body}/></pre>}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="flex items-center gap-1.5">{c.authorAvatar ? <Avatar alt={c.authorName} src={c.authorAvatar} size={20}/> : null}<span className="text-default">{c.authorName}</span></span>
        <TimeAgo at={c.date}/>
        <span className="flex items-center gap-1"><GitCommitIcon size={12} className="shrink-0"/><code>{c.sha}</code></span>
        {c.parents.map((p) => <span key={p}>parent <PrimerLink as={CodeLink} owner={owner} repo={repo} to={`commit/${p}`}><Sha sha={p}/></PrimerLink></span>)}
      </p>
      <ContainedIn owner={owner} repo={repo} repoId={repoId} sha={c.sha}/>
      <CommitChecksSection owner={owner} repo={repo} repoId={repoId} sha={c.sha}/>
    </>
  );
}
