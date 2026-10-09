// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Source: a directory or a file at a ref (`src/{branch|tag|commit}/{ref}/{path}`)
// and a file's blame (`blame/…`). The ref resolves from the pool; the tree is
// read by (repository, commit, path), files by blob SHA, highlighting by blob
// SHA — all cached forever. Hovering an entry prefetches it, and a file seen
// in this tab paints highlighted in its first frame (memory cache), so
// switching between files never waits.

import {useNavigate} from '@tanstack/react-router';
import {ChevronDown, File, FileSymlink, Folder, FolderGit2, GitBranch, GitCommitHorizontal, History, ScrollText, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useMemo, useState} from 'react';
import {sitePath} from '../../app/config.ts';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {type RefKind, type Resolved, codeSplat, parentPath, resolveRef, shortSha} from '../../code/refs.ts';
import {CodeSource, encodePath, type FileContent} from '../../code/source.ts';
import type {APIBlame, APITree, APITreeEntry} from '../../protocol/types.gen.ts';
import {
  BlameCell, Button, CodeLine, CodeTokens, CommandPopover, EmptyState, Icon, LineNo, ListRow, type PickOption, SegmentedControl, Skeleton, TextLink,
} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {ago} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {hasRefs, type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {Lines} from './Lines.tsx';
import {RowList} from './RowList.tsx';
import {CodeLink, codeTo, useCodeRows} from './nav.tsx';
import {Unloaded} from './states.tsx';
import {BlobImage, ReadmePanel, readmeOf, renderable, RenderedMarkup} from './Rendered.tsx';

interface SrcProps extends CodeViewProps {
  blame: boolean;
  kind: RefKind | undefined;
  rest: string[];
}

export const SrcView = observer(function SrcView(props: SrcProps) {
  const pool = usePool();
  const refs = refTable(pool, props.repoId);
  const r = resolveRef(refs, props.kind, props.rest);
  if (!r) {
    return (
      <CodeFrame view={props} title={props.rest.join('/') || 'Files'}>
        {() => <NoRef repoId={props.repoId} named={props.kind !== undefined}/>}
      </CodeFrame>
    );
  }
  return <SrcAt {...props} at={r}/>;
});

/** The ref is not known here: the repository's branches have not arrived yet, or it does not exist. */
const NoRef = observer(function NoRef({repoId, named}: {repoId: number; named: boolean}) {
  const pool = usePool();
  const {data} = useSession();
  const loaded = hasRefs(pool, repoId);
  if (!loaded && data.status.loading > 0) return <ListSkeleton/>;
  return (
    <EmptyState icon={GitBranch} title={named ? 'Branch or tag not found' : 'No code here'}
      description={named ? 'It does not exist, was deleted, or is not on this device.' : loaded ? 'The default branch is not on this device.' : 'This repository is empty, or its code is not on this device.'}/>
  );
});

function ListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy>
      {Array.from({length: 8}, (_, i) => <ListRow key={i} role="presentation" leading={<Skeleton className="size-4"/>}><Skeleton className="h-3 w-48"/></ListRow>)}
    </div>
  );
}

const SrcAt = observer(function SrcAt(props: SrcProps & {at: Resolved}) {
  const {repoId, at} = props;
  const src = useSource();
  const parent = parentPath(at.path);
  const name = at.path.slice(parent ? parent.length + 1 : 0);
  // The parent directory says what the path is (and the blob's SHA and size).
  const parentKey = at.path ? CodeSource.treeKey(repoId, at.sha, parent) : undefined;
  const tree = useLoad(parentKey, () => (parentKey ? src.peek<APITree>(parentKey) : undefined), () => src.tree(repoId, at.sha, parent));
  const entry = tree.state === 'ready' ? tree.value.entries.find((e) => e.name === name) : undefined;
  const title = <Breadcrumbs {...props}/>;
  const controls = <SrcControls {...props} entry={entry}/>;
  let body: (scroller: HTMLDivElement | null) => ReactNode;
  if (!at.path || entry?.type === 'tree') {
    body = (scroller) => <DirView {...props} scroller={scroller}/>;
  } else if (tree.state !== 'ready') {
    body = () => <Unloaded loaded={tree} what="This file"/>;
  } else if (!entry) {
    body = () => <EmptyState icon={File} title="Not found" description={`There is no ${at.path} at ${shortSha(at.sha)}.`}/>;
  } else if (entry.type === 'commit') {
    body = () => <EmptyState icon={FolderGit2} title="A submodule" description={`${at.path} is a submodule at commit ${shortSha(entry.sha)}.`}/>;
  } else {
    body = (scroller) => <FileView key={entry.sha} {...props} entry={entry} scroller={scroller}/>;
  }
  return <CodeFrame view={props} title={title} controls={controls}>{body}</CodeFrame>;
});

/** owner/repo is in the context; the title is the path, each directory a link. */
function Breadcrumbs({owner, repo, at}: SrcProps & {at: Resolved}) {
  const parts = at.path ? at.path.split('/') : [];
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-code">
      {/* The repository is in the breadcrumb already: its root is "/" here, "Files" on the root page. */}
      {parts.length ? <TextLink><CodeLink owner={owner} repo={repo} to={codeSplat('src', at)}><span aria-label={`${repo} root`}>/</span></CodeLink></TextLink> : <span className="font-sans">Files</span>}
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-fg-subtle">/</span>}
          {i === parts.length - 1 ? <span className="truncate">{p}</span> :
            <TextLink><CodeLink owner={owner} repo={repo} to={codeSplat('src', at, parts.slice(0, i + 1).join('/'))}>{p}</CodeLink></TextLink>}
        </span>
      ))}
    </span>
  );
}

const SrcControls = observer(function SrcControls({owner, repo, repoId, at, blame, entry}: SrcProps & {at: Resolved; entry: APITreeEntry | undefined}) {
  const app = useApp();
  const pool = usePool();
  const file = entry !== undefined && entry.type !== 'tree';
  const def = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  return (
    <>
      <RefMenu owner={owner} repo={repo} repoId={repoId} at={at} view={blame ? 'blame' : 'src'}/>
      {at.kind === 'branch' && def && at.ref !== def && (
        <Button size="sm" variant="ghost" asChild>
          <CodeLink owner={owner} repo={repo} to={`compare/${def}...${at.ref}`}>Compare</CodeLink>
        </Button>
      )}
      <Button size="sm" variant="ghost" asChild>
        <CodeLink owner={owner} repo={repo} to={codeSplat('commits', at, at.path)}><Icon icon={History} size="sm"/>History</CodeLink>
      </Button>
      {file && (
        <Button size="sm" variant="ghost" asChild>
          <CodeLink owner={owner} repo={repo} to={codeSplat(blame ? 'src' : 'blame', at, at.path)}><Icon icon={blame ? File : ScrollText} size="sm"/>{blame ? 'Source' : 'Blame'}</CodeLink>
        </Button>
      )}
      {file && (
        <Button size="sm" variant="ghost" asChild>
          <a href={sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/commit/${at.sha}/${encodePath(at.path)}`)} target="_blank" rel="noopener noreferrer">Raw</a>
        </Button>
      )}
    </>
  );
});

/**
 * The branch or tag on screen, and every other one to switch to (same path): a picker that filters as you
 * type (Enter takes the first match), branches first.
 */
const RefMenu = observer(function RefMenu({owner, repo, repoId, at, view}: {owner: string; repo: string; repoId: number; at: Resolved; view: 'src' | 'blame' | 'commits'}) {
  const pool = usePool();
  const navigate = useNavigate();
  const refs = refTable(pool, repoId);
  const branches = [...refs.branches.keys()].sort((a, b) => (a === refs.defaultBranch ? -1 : b === refs.defaultBranch ? 1 : a.localeCompare(b)));
  const tags = [...refs.tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  const current = `${at.kind}:${at.ref}`;
  const option = (kind: RefKind, ref: string): PickOption => ({
    value: `${kind}:${ref}`, label: ref, group: kind === 'branch' ? 'Branches' : 'Tags', icon: kind === 'branch' ? GitBranch : Tag,
    meta: kind === 'branch' && ref === refs.defaultBranch ? 'default' : undefined, checked: current === `${kind}:${ref}`,
    onSelect: () => {
      void navigate(codeTo(owner, repo, codeSplat(view, {kind, ref}, at.path)));
    },
  });
  const label = at.kind === 'commit' ? shortSha(at.sha) : at.ref;
  return (
    <CommandPopover width="md" label="Switch branch or tag" placeholder="Find a branch or tag…" empty="No branch or tag is on this device."
      options={[...branches.map((b) => option('branch', b)), ...tags.map((t) => option('tag', t))]}
      trigger={
        <Button size="sm" icon={at.kind === 'tag' ? Tag : at.kind === 'commit' ? GitCommitHorizontal : GitBranch} aria-label={`Ref: ${label}`}>
          <span className="max-w-xs truncate font-mono">{label}</span><Icon icon={ChevronDown} size="sm"/>
        </Button>
      }/>
  );
});

// ---- directory ----

const ENTRY_ICON = {tree: Folder, blob: File, symlink: FileSymlink, commit: FolderGit2} as const;

function formatSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const DirView = observer(function DirView({owner, repo, repoId, at, scroller}: SrcProps & {at: Resolved; scroller: HTMLDivElement | null}) {
  const src = useSource();
  const key = CodeSource.treeKey(repoId, at.sha, at.path);
  const tree = useLoad(key, () => src.peek<APITree>(key), () => src.tree(repoId, at.sha, at.path));
  if (tree.state !== 'ready') return <Unloaded loaded={tree} what="This directory" skeleton={<ListSkeleton/>}/>;
  const readme = readmeOf(tree.value.entries);
  return (
    <>
      <Entries owner={owner} repo={repo} repoId={repoId} at={at} tree={tree.value} scroller={scroller}/>
      {readme && <div className="px-4 py-4"><ReadmePanel repoId={repoId} entry={readme} dir={at.path} at={at}/></div>}
    </>
  );
});

function Entries({owner, repo, repoId, at, tree, scroller}: {owner: string; repo: string; repoId: number; at: Resolved; tree: APITree; scroller: HTMLDivElement | null}) {
  const pathOf = (e: APITreeEntry) => (at.path ? `${at.path}/${e.name}` : e.name);
  const rows = useCodeRows<APITreeEntry>(owner, repo, (e) => codeSplat('src', at, pathOf(e)));
  const src = useSource();
  const entries = useMemo(() => [...tree.entries].sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name)), [tree]);
  if (!entries.length) return <EmptyState icon={Folder} title="Empty directory"/>;
  return (
    <RowList items={entries} scroller={scroller} label="Files" keyOf={(e) => e.name}
      row={(e) => ({
        leading: <Icon icon={ENTRY_ICON[e.type as keyof typeof ENTRY_ICON]} size="sm"/>,
        main: e.name,
        trailing: e.type === 'blob' ? <span className="tabular-nums">{formatSize(e.size)}</span> : undefined,
      })}
      onOpen={rows.onOpen} linkOf={rows.linkOf}
      // Hover or the cursor: fetch the entry and highlight it, so opening it paints at once.
      onIntent={(e) => {
        const p = pathOf(e);
        if (e.type === 'tree') void src.tree(repoId, at.sha, p).catch(() => undefined);
        else if (e.type === 'blob') {
          void src.blob(repoId, e.sha, p, e.size).then((c) => (c.kind === 'text' ? src.highlight(repoId, e.sha, p, c.text) : null)).catch(() => undefined);
        }
      }}/>
  );
}

// ---- file ----

interface FileProps extends SrcProps {
  at: Resolved;
  entry: APITreeEntry;
  scroller: HTMLDivElement | null;
}

const FileView = observer(function FileView(props: FileProps) {
  const {repoId, entry, at} = props;
  const src = useSource();
  const key = CodeSource.blobKey(repoId, entry.sha);
  const content = useLoad(key, () => src.peek<FileContent>(key), () => src.blob(repoId, entry.sha, at.path, entry.size));
  if (content.state !== 'ready') return <Unloaded loaded={content} what="This file" skeleton={<CodeSkeleton/>}/>;
  const c = content.value;
  switch (c.kind) {
    case 'text':
      if (props.blame) return <BlameView {...props} text={c.text}/>;
      return renderable(at.path) ? <PreviewableFile {...props} text={c.text}/> : <TextFile {...props} text={c.text}/>;
    case 'image':
      return <BlobImage bytes={c.bytes} type={c.type} alt={at.path}/>;
    case 'binary':
      return <EmptyState icon={File} title="Binary file" description={`${formatSize(c.size)} — not shown. Use Raw to download it.`}/>;
    case 'large':
      return <EmptyState icon={File} title="Large file" description={`${formatSize(c.size)} — too large to show here. Use Raw to download it.`}/>;
  }
});

const SKELETON_LINES = ['h-3 w-48', 'h-3 w-64', 'h-3 w-40', 'h-3 w-72', 'h-3 w-56'] as const;

export function CodeSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-busy>
      {SKELETON_LINES.map((c, i) => <Skeleton key={i} className={c}/>)}
    </div>
  );
}

/** A markdown or SVG file: rendered (Preview, the default) or its source with line numbers (Source). */
function PreviewableFile(props: FileProps & {text: string}) {
  const {repoId, entry, at, text} = props;
  const [mode, setMode] = useState<'preview' | 'source'>(() => (/^#L\d+$/.test(location.hash) ? 'source' : 'preview'));
  const kind = renderable(at.path);
  const toggle = (
    <span className="ml-auto">
      <SegmentedControl label="Show the file" value={mode} onChange={setMode} options={[{value: 'preview', label: 'Preview'}, {value: 'source', label: 'Source'}]}/>
    </span>
  );
  if (mode === 'source') return <TextFile {...props} text={text} toolbar={toggle}/>;
  return (
    <>
      <FileMeta lines={splitLines(text).length} size={entry.size}>{toggle}</FileMeta>
      {kind === 'svg' ? <BlobImage bytes={text} type="image/svg+xml" alt={at.path}/> :
        <PageColumn><RenderedMarkup repoId={repoId} sha={entry.sha} path={at.path} text={text} at={at}/></PageColumn>}
    </>
  );
}

/** Splits text into lines (a final newline ends the last line; it does not start an empty one). */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** The highlighting of a file by its blob SHA (memory first: a file switched back to paints highlighted). */
function useHighlight(repoId: number, sha: string, path: string, text: string) {
  const src = useSource();
  const hl = useLoad(`hl:${String(repoId)}:${sha}:${path}`, () => src.peekHighlight(repoId, sha, path) ?? undefined, () => src.highlight(repoId, sha, path, text));
  return hl.state === 'ready' ? hl.value : null;
}

/** The line a #L12 link names (0-based), if any. */
function hashLine(): number | undefined {
  const m = /^#L(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) - 1 : undefined;
}

const TextFile = observer(function TextFile({repoId, entry, at, text, scroller, toolbar}: FileProps & {text: string; toolbar?: ReactNode}) {
  const lines = useMemo(() => splitLines(text), [text]);
  const hl = useHighlight(repoId, entry.sha, at.path, text);
  const [active] = useState(hashLine);
  const line = useCallback((i: number) => (
    <CodeLine id={`L${String(i + 1)}`} active={i === active} gutter={<LineNo n={i + 1}/>}>
      <CodeTokens text={lines[i] ?? ''} hl={hl} line={i}/>
    </CodeLine>
  ), [lines, hl, active]);
  useMarkPainted(at.path);
  return (
    <>
      <FileMeta lines={lines.length} size={entry.size}>{toolbar}</FileMeta>
      <Lines count={lines.length} scroller={scroller} line={line} label={`${at.path}, ${String(lines.length)} lines`} initial={active}/>
    </>
  );
});

/** RUM-style measure for the e2e: a file view's first paint after the navigation that opened it. */
function useMarkPainted(path: string): void {
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        performance.mark('code:file', {detail: {path}});
      } catch {
        // no User Timing
      }
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [path]);
}

function FileMeta({lines, size, children}: {lines: number; size: number | undefined; children?: ReactNode}) {
  return (
    <div className="flex h-control items-center gap-3 border-b border-border-subtle px-4 text-sm text-fg-subtle tabular-nums">
      <span>{lines} {lines === 1 ? 'line' : 'lines'}</span>
      {size !== undefined && <span>{formatSize(size)}</span>}
      {children}
    </div>
  );
}

// ---- blame ----

const BlameView = observer(function BlameView({owner, repo, repoId, entry, at, text, scroller}: FileProps & {text: string}) {
  const src = useSource();
  const key = `blame:${String(repoId)}:${at.sha}:${at.path}`;
  const blame = useLoad(key, () => src.peek<APIBlame>(key), () => src.blame(repoId, at.sha, at.path));
  const lines = useMemo(() => splitLines(text), [text]);
  const hl = useHighlight(repoId, entry.sha, at.path, text);
  // Per line: the part it belongs to (index), and whether it starts the part.
  const parts = useMemo(() => {
    if (blame.state !== 'ready') return undefined;
    const of = new Int32Array(lines.length).fill(-1);
    blame.value.parts.forEach((p, k) => {
      for (let l = p.start_line - 1; l < p.start_line - 1 + p.lines && l < of.length; l++) of[l] = k;
    });
    return of;
  }, [blame, lines.length]);
  const line = useCallback((i: number) => {
    const k = parts?.[i] ?? -1;
    const b = blame.state === 'ready' ? blame.value : undefined;
    const part = b ? b.parts[k] : undefined;
    const commit = b && part ? b.commits[part.sha] : undefined;
    const first = part !== undefined && part.start_line - 1 === i;
    return (
      <CodeLine gutter={<>
        <BlameCell first={first} meta={commit ? ago(commit.authored_at) : undefined}>
          {part && commit && (
            <span title={`${commit.author_name} · ${commit.summary}`} className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-fg">{commit.author_name}</span>
              <TextLink><CodeLink owner={owner} repo={repo} to={`commit/${part.sha}`}>{commit.summary}</CodeLink></TextLink>
            </span>
          )}
        </BlameCell>
        <LineNo n={i + 1}/>
      </>}>
        <CodeTokens text={lines[i] ?? ''} hl={hl} line={i}/>
      </CodeLine>
    );
  }, [parts, blame, lines, hl, owner, repo]);
  if (blame.state !== 'ready') return <Unloaded loaded={blame} what="This blame" skeleton={<CodeSkeleton/>}/>;
  return (
    <>
      <FileMeta lines={lines.length} size={entry.size}>
        {blame.value.uses_ignore_revs && <span>Ignoring the revisions in .git-blame-ignore-revs</span>}
      </FileMeta>
      <Lines count={lines.length} scroller={scroller} line={line} label={`Blame of ${at.path}`}/>
    </>
  );
});

export type {Loaded};
