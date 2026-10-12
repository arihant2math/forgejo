// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Cache trees by repository/commit/path and content/highlighting by blob SHA for offline reads.

import {useNavigate, useRouterState, useSearch} from '@tanstack/react-router';
import {Missing} from '../../app/Missing.tsx';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {observer} from 'mobx-react-lite';
import {createContext, lazy, Suspense, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {canWrite} from '../../app/access.ts';
import {editableText} from './fileWrite.ts';
import {FileOperations, type FileDropProps, type FileRemoval} from './FileOperations.tsx';
import {notify} from '../../app/notices.ts';
import {permalink} from '../../code/permalink.ts';
import {sitePath} from '../../app/config.ts';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {PageColumn} from '../../app/shell/Frame.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {type RefKind, type Resolved, codeSplat, parentPath, resolveRef, shortSha} from '../../code/refs.ts';
import {CodeSource, encodePath, type FileContent} from '../../code/source.ts';
import type {APIBlame, APITree, APITreeEntry} from '../../protocol/types.gen.ts';
import {BlameCell, CodeLine, CodeTokens, LineAction, LineNo} from '../../code/parts.tsx';
import {FileSurface} from '../../code/FileSurface.tsx';
import {usePool} from '../issues/cells.tsx';
import {ago} from '../issues/format.ts';
import {CodeFrame, type CodeViewProps} from './CodePage.tsx';
import {hasRefs, type Loaded, refTable, useLoad, useSource} from './hooks.ts';
import {Lines, type LinesHandle} from './Lines.tsx';
import {GoToFile} from './FileFinder.tsx';
import {RefMenu} from './RefMenu.tsx';
import {CodeLink, codeTo} from './nav.tsx';
import {Unloaded} from './states.tsx';
import {DirEntries, FilesPanel, formatSize, RefCommit} from './tree.tsx';
import {BlobImage, ReadmePanel, readmeOf, renderable, RenderedMarkup} from './Rendered.tsx';
import {CopyIcon, DownloadIcon, FileIcon, FileSubmoduleIcon, GitBranchIcon, HistoryIcon, KebabHorizontalIcon, PencilIcon, TrashIcon} from '@primer/octicons-react';
import {ButtonGroup, IconButton, LinkButton, SegmentedControl, ActionMenu, ActionList} from '@primer/react';
import {SkeletonBox, Blankslate} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

const FileEditor = lazy(() => import('./FileEditor.tsx'));

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
      <CodeFrame view={props} title={props.rest.join('/') || 'Code'}>
        {() => <NoRef repoId={props.repoId} named={props.kind !== undefined}/>}
      </CodeFrame>
    );
  }
  return <SrcAt {...props} at={r}/>;
});

const NoRef = observer(function NoRef({repoId, named}: {repoId: number; named: boolean}) {
  const pool = usePool();
  const {data} = useSession();
  const loaded = hasRefs(pool, repoId);
  if (!loaded && data.status.loading > 0) return <ListSkeleton/>;
  return (
    <Missing icon={GitBranchIcon} what={named ? 'This branch or tag' : 'This repository’s code'}/>
  );
});

function ListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy>
      {Array.from({length: 8}, (_, i) => <div key={i} className="flex items-center gap-2 px-4 py-2"><SkeletonBox className="size-4"/><SkeletonBox className="h-3 w-48"/></div>)}
    </div>
  );
}

const SrcAt = observer(function SrcAt(props: SrcProps & {at: Resolved}) {
  const {repoId, at} = props;
  const src = useSource();
  const parent = parentPath(at.path);
  const name = at.path.slice(parent ? parent.length + 1 : 0);
  const parentKey = at.path ? CodeSource.treeKey(repoId, at.sha, parent) : undefined;
  const tree = useLoad(parentKey, () => (parentKey ? src.peek<APITree>(parentKey) : undefined), () => src.tree(repoId, at.sha, parent));
  const entry = tree.state === 'ready' ? tree.value.entries.find((e) => e.name === name) : undefined;
  const title = <Breadcrumbs owner={props.owner} repo={props.repo} at={at}/>;
  const navigate = useNavigate();
  const up = () => {
    if (at.path) void navigate(codeTo(props.owner, props.repo, codeSplat('src', at, parent)));
  };
  useShortcutScope('code');
  useShortcut('code.up', up);
  useShortcut('code.upAlt', up);
  useShortcut('code.permalink', () => {
    void navigate({...codeTo(props.owner, props.repo, codeSplat(props.blame ? 'blame' : 'src', {...at, kind: 'commit', ref: at.sha}, at.path)), hash: true, replace: true});
  });
  const folder = !at.path || entry?.type === 'tree';
  const target = at.path && entry ? {sha: folder ? at.sha : entry.sha, folder} : undefined;
  let body: (scroller: HTMLDivElement | null, dropProps: FileDropProps) => ReactNode;
  if (!at.path || entry?.type === 'tree') {
    body = (scroller, dropProps) => <DirView {...props} scroller={scroller} dropProps={dropProps}/>;
  } else if (tree.state !== 'ready') {
    body = () => <Unloaded loaded={tree} what="This file or folder"/>;
  } else if (!entry) {
    body = () => <EmptyState icon={FileIcon} title="Not found" description={`There is no ${at.path} at ${shortSha(at.sha)}.`}/>;
  } else if (entry.type === 'commit') {
    body = () => <EmptyState icon={FileSubmoduleIcon} title="A submodule" description={`${at.path} is a submodule at commit ${shortSha(entry.sha)}.`}/>;
  } else {
    body = (scroller) => <FileView key={entry.sha} {...props} entry={entry} scroller={scroller}/>;
  }
  const docTitle = `${at.path || 'Code'}${props.blame ? ' (blame)' : ''}`;
  const frame = (operations: ReactNode, dropProps: FileDropProps, remove?: FileRemoval) => <CodeFrame view={props} title={title} controls={<SrcControls {...props} entry={entry} operations={operations} remove={remove}/>} docTitle={docTitle}>
    {(scroller) => body(scroller, dropProps)}
  </CodeFrame>;
  // Do not offer writes until the path is confirmed to exist.
  if (at.path && !entry) return frame(null, {});
  return <FileOperations owner={props.owner} repo={props.repo} repoId={repoId} at={at} target={target}>{frame}</FileOperations>;
});

/** linkLast makes a history breadcrumb link to the path source. */
export function Breadcrumbs({owner, repo, at, view = 'src', linkLast = false}: {owner: string; repo: string; at: Resolved; view?: 'src' | 'commits'; linkLast?: boolean}) {
  const parts = at.path ? at.path.split('/') : [];
  const root = view === 'src' ? 'Code' : 'Commits';
  return (
    <span className="flex min-w-0 items-center gap-1">
      {parts.length ? <CodeLink className="text-default hover:text-accent hover:underline" owner={owner} repo={repo} to={codeSplat(view, at)}>{root}</CodeLink> : <span>{root}</span>}
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <span className="text-muted">/</span>
          {i === parts.length - 1 && !linkLast ? <span className="truncate">{p}</span> :
            <CodeLink className="text-default hover:text-accent hover:underline" owner={owner} repo={repo} to={codeSplat(i === parts.length - 1 ? 'src' : view, at, parts.slice(0, i + 1).join('/'))}>{p}</CodeLink>}
        </span>
      ))}
    </span>
  );
}

/** GitHub's title row: ref, compare, history, Go to file, Add file (directories) and the path's ⋯ menu. */
const SrcControls = observer(function SrcControls({owner, repo, repoId, at, blame, entry, operations, remove}: SrcProps & {
  at: Resolved; entry: APITreeEntry | undefined; operations: ReactNode; remove: FileRemoval | undefined;
}) {
  const pool = usePool();
  const file = entry !== undefined && entry.type !== 'tree';
  const def = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  return (
    <>
      <RefMenu owner={owner} repo={repo} repoId={repoId} at={at} view={blame ? 'blame' : 'src'}/>
      {at.kind === 'branch' && def && at.ref !== def && (
        <RouterLinkButton variant="default" size="small" {...codeTo(owner, repo, `compare/${def}...${at.ref}`)}>Compare</RouterLinkButton>
      )}
      {at.kind === 'tag' && def && (
        <RouterLinkButton variant="default" size="small" {...codeTo(owner, repo, `compare/${at.ref}...${def}`)}>Compare</RouterLinkButton>
      )}
      <RouterLinkButton variant="default" size="small" leadingVisual={HistoryIcon} {...codeTo(owner, repo, codeSplat('commits', at, at.path))}>History</RouterLinkButton>
      <GoToFile owner={owner} repo={repo} repoId={repoId} at={at}/>
      {!file && operations}
      {at.path && <FileLinkMenu owner={owner} repo={repo} at={at} folder={!file} remove={remove}/>}
    </>
  );
});

/** Branch raw URLs follow the branch; commit raw URLs remain fixed. */
export function rawPath(owner: string, repo: string, at: Resolved): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${at.kind}/${at.kind === 'commit' ? at.sha : encodePath(at.ref)}/${encodePath(at.path)}`;
}

function FileLinkMenu({owner, repo, at, line = false, folder = false, remove}: {owner: string; repo: string; at: Resolved; line?: boolean; folder?: boolean; remove?: FileRemoval | undefined}) {
  const app = useApp();
  const hash = useRouterState({select: (s) => s.location.hash});
  const copy = (value: string, title: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      notify(app, {tone: 'success', title});
    }, () => {
      notify(app, {tone: 'danger', title: 'Could not copy', description: value});
    });
  };
  return (
    <ActionMenu>
      <ActionMenu.Anchor>{line ? <LineAction label="Line actions" tabIndex={0}>…</LineAction> : <IconButton icon={KebabHorizontalIcon} variant="default" size="small" aria-label={folder ? 'Directory actions' : 'File actions'}/>}</ActionMenu.Anchor>
      <ActionMenu.Overlay align="end"><ActionList>
        {line ? <ActionList.Item onSelect={() => { copy(location.href, 'Link copied'); }}>Copy line link</ActionList.Item> :
          <ActionList.Item onSelect={() => { copy(at.path, 'Path copied'); }}>Copy path</ActionList.Item>}
        <ActionList.Item onSelect={() => {
          copy(new URL(sitePath(app.config, permalink(owner, repo, at.sha, at.path, hash)), location.origin).href, 'Link copied');
        }}>Copy permalink</ActionList.Item>
        {remove && <>
          <ActionList.Divider/>
          <ActionList.Item variant="danger" disabled={remove.disabled} onSelect={remove.onSelect}>
            <ActionList.LeadingVisual><TrashIcon/></ActionList.LeadingVisual>{folder ? 'Delete directory' : 'Delete file'}
          </ActionList.Item>
        </>}
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}

const DirView = observer(function DirView({owner, repo, repoId, at, scroller, dropProps}: SrcProps & {at: Resolved; scroller: HTMLDivElement | null; dropProps: FileDropProps}) {
  const src = useSource();
  const key = CodeSource.treeKey(repoId, at.sha, at.path);
  const tree = useLoad(key, () => src.peek<APITree>(key), () => src.tree(repoId, at.sha, at.path));
  if (tree.state !== 'ready') return <Unloaded loaded={tree} what="This directory" skeleton={<ListSkeleton/>}/>;
  const readme = readmeOf(tree.value.entries);
  return (
    <PageColumn wide>
      <div {...dropProps}>
        <FilesPanel title={<RefCommit owner={owner} repo={repo} repoId={repoId} kind={at.kind} name={at.ref} sha={at.sha}/>}>
          <DirEntries owner={owner} repo={repo} repoId={repoId} at={at} tree={tree.value} scroller={scroller}/>
        </FilesPanel>
      </div>
      {readme && <ReadmePanel repoId={repoId} entry={readme} dir={at.path} at={at}/>}
    </PageColumn>
  );
});

interface FileProps extends SrcProps {
  at: Resolved;
  entry: APITreeEntry;
  scroller: HTMLDivElement | null;
}

const FileView = observer(function FileView(props: FileProps) {
  const {repoId, entry, at} = props;
  const src = useSource();
  const key = CodeSource.blobKey(repoId, entry.sha);
  // Read stored highlighting with content to avoid a plain-text first frame.
  const content = useLoad(key, () => src.peek<FileContent>(key), async () => (await Promise.all([
    src.blob(repoId, entry.sha, at.path, entry.size), src.loadHighlight(repoId, entry.sha, at.path),
  ]))[0]);
  if (content.state !== 'ready') return <Unloaded loaded={content} what="This file" skeleton={<CodeSkeleton/>}/>;
  const c = content.value;
  const raw = <RawActions owner={props.owner} repo={props.repo} at={at} text={c.kind === 'text' ? c.text : undefined}/>;
  let body: ReactNode;
  switch (c.kind) {
    case 'text':
      body = <EditableFile {...props} text={c.text}/>;
      break;
    case 'image':
      body = <ImageFile bytes={c.bytes} type={c.type} path={at.path} size={entry.size}/>;
      break;
    case 'binary':
      body = <><FileMeta size={c.size}/><Blankslate><Blankslate.Visual><FileIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Binary file</Blankslate.Heading><Blankslate.Description>{`${formatSize(c.size)} — not shown. Use Raw to download it.`}</Blankslate.Description></Blankslate></>;
      break;
    case 'large':
      body = <><FileMeta size={c.size}/><Blankslate><Blankslate.Visual><FileIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Large file</Blankslate.Heading><Blankslate.Description>{`${formatSize(c.size)} — too large to show here. Use Raw to download it.`}</Blankslate.Description></Blankslate></>;
  }
  const mode = c.kind === 'text' ? <ViewSwitch owner={props.owner} repo={props.repo} at={at} blame={props.blame}/> : undefined;
  return <FileHeader value={{mode, actions: raw}}>{body}</FileHeader>;
});

/** The file header's view switch and raw-file actions, which FileMeta places around the file's facts. */
const FileHeader = createContext<{mode?: ReactNode; actions?: ReactNode}>({});

/** Renderable files open as a preview unless the address asks for code (GitHub's ?plain=1) or names lines. */
function usePlain(): boolean {
  const plain: unknown = useSearch({strict: false, select: (s): unknown => (s as Record<string, unknown>).plain});
  const hash = useRouterState({select: (s) => s.location.hash});
  return plain === '1' || plain === 1 || hashRange(hash) !== undefined;
}

/** A switch rather than links, which would read as pressed buttons. */
function ViewSwitch({owner, repo, at, blame}: {owner: string; repo: string; at: Resolved; blame: boolean}) {
  const navigate = useNavigate();
  const preview = renderable(at.path) !== undefined;
  const plain = usePlain();
  const views = [...(preview ? ['preview' as const] : []), 'code' as const, 'blame' as const];
  const current = blame ? 'blame' : preview && !plain ? 'preview' : 'code';
  const show = (view: typeof views[number]) => {
    const to = codeTo(owner, repo, codeSplat(view === 'blame' ? 'blame' : 'src', at, at.path));
    if (view === 'preview') void navigate({...to, search: {}});
    else void navigate({...to, hash: true, search: view === 'code' && preview ? {plain: '1'} as never : {}});
  };
  return (
    <SegmentedControl size="small" aria-label="File view" onChange={(i) => { const v = views[i]; if (v) show(v); }}>
      {views.map((v) => <SegmentedControl.Button key={v} selected={v === current}>{v === 'preview' ? 'Preview' : v === 'code' ? 'Code' : 'Blame'}</SegmentedControl.Button>)}
    </SegmentedControl>
  );
}

function RawActions({owner, repo, at, text}: {owner: string; repo: string; at: Resolved; text: string | undefined}) {
  const app = useApp();
  const href = sitePath(app.config, rawPath(owner, repo, at));
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      notify(app, {tone: 'success', title: 'File copied'});
    }, () => {
      notify(app, {tone: 'danger', title: 'Could not copy the file'});
    });
  };
  return (
    <ButtonGroup>
      <LinkButton size="small" href={href} target="_blank" rel="noopener noreferrer">Raw</LinkButton>
      {text !== undefined && <IconButton icon={CopyIcon} size="small" aria-label="Copy raw file" onClick={() => { copy(text); }}/>}
      <IconButton as="a" icon={DownloadIcon} size="small" aria-label="Download raw file" href={href} download={at.path.slice(at.path.lastIndexOf('/') + 1)}/>
    </ButtonGroup>
  );
}

const EditableFile = observer(function EditableFile(props: FileProps & {text: string}) {
  const [editing, setEditing] = useState(false);
  const writer = canWrite(useSession(), props.repoId);
  const allowed = writer && props.at.kind === 'branch' && editableText(props.text);
  useShortcut('code.editFile', () => {setEditing(true);}, allowed && !editing);
  if (editing) return <Suspense fallback={<CodeSkeleton/>}><FileEditor owner={props.owner} repo={props.repo} repoId={props.repoId} at={props.at} sha={props.entry.sha} original={props.text} onCancel={() => {setEditing(false);}}/></Suspense>;
  const edit = allowed ? <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit this file" onClick={() => {setEditing(true);}}/> :
    !writer && props.at.kind === 'branch' && editableText(props.text) ? <IconButton icon={PencilIcon} variant="invisible" size="small" aria-label="Edit this file" description="Fork this repository to edit this file" inactive aria-disabled/> : null;
  return <>
    {props.text === '' ? <><FileMeta lines={0} size={props.entry.size}>{edit}</FileMeta><Blankslate><Blankslate.Visual><FileIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Empty file</Blankslate.Heading><Blankslate.Description>This file has no content.</Blankslate.Description></Blankslate></> : props.blame ? <BlameView {...props} edit={edit}/> : renderable(props.at.path) ? <PreviewableFile {...props} edit={edit}/> : <TextFile {...props} edit={edit}/>}
  </>;
});

const SKELETON_LINES = ['h-3 w-48', 'h-3 w-64', 'h-3 w-40', 'h-3 w-72', 'h-3 w-56'] as const;

export function CodeSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-busy>
      {SKELETON_LINES.map((c, i) => <SkeletonBox key={i} className={c}/>)}
    </div>
  );
}

function PreviewableFile(props: FileProps & {text: string; edit: ReactNode}) {
  const {repoId, entry, at, text} = props;
  const kind = renderable(at.path);
  if (usePlain()) return <TextFile {...props} text={text}/>;
  return (
    <>
      <FileMeta lines={splitLines(text).length} size={entry.size}>{props.edit}</FileMeta>
      {kind === 'svg' ? <BlobImage bytes={text} type="image/svg+xml" alt={at.path}/> :
        <PageColumn><RenderedMarkup repoId={repoId} sha={entry.sha} path={at.path} text={text} at={at}/></PageColumn>}
    </>
  );
}

/** A final newline ends the last line without adding an empty one. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function useHighlight(repoId: number, sha: string, path: string, text: string) {
  const src = useSource();
  const hl = useLoad(`hl:${String(repoId)}:${sha}:${path}`, () => src.peekHighlight(repoId, sha, path) ?? undefined, () => src.highlight(repoId, sha, path, text));
  return hl.state === 'ready' ? hl.value : null;
}

/** Returns a 0-based, ordered line range from a supported fragment, or undefined. */
export function hashRange(hash: string): [number, number] | undefined {
  const m = /^#?L(\d+)(?:-L?(\d+))?$/.exec(hash);
  if (!m) return undefined;
  const a = Number(m[1]) - 1;
  const b = m[2] === undefined ? a : Number(m[2]) - 1;
  return a < 0 || b < 0 ? undefined : [Math.min(a, b), Math.max(a, b)];
}

function TextFile(props: FileProps & {text: string; edit: ReactNode}) {
  return typeof Worker === 'undefined' ? <LinkedTextFile {...props}/> : <FileSurface name={props.at.path} text={props.text} scroller={props.scroller} cacheKey={props.entry.sha} fallback={<LinkedTextFile {...props}/>}>
    <FileMeta lines={splitLines(props.text).length} size={props.entry.size}>{props.edit}</FileMeta>
  </FileSurface>;
}

const LinkedTextFile = observer(function LinkedTextFile({owner, repo, repoId, entry, at, text, scroller, edit}: FileProps & {text: string; edit: ReactNode}) {
  const lines = useMemo(() => splitLines(text), [text]);
  const hl = useHighlight(repoId, entry.sha, at.path, text);
  const {range, view, initial, pick} = useLineLinks();
  const line = useCallback((i: number) => {
    const named = range !== undefined && i >= range[0] && i <= range[1];
    return (
      <CodeLine id={`L${String(i + 1)}`} active={range?.[0] === i} linked={named} gutter={<LineNo n={i + 1} onPick={pick}/>} action={range?.[0] === i ? <FileLinkMenu owner={owner} repo={repo} at={at} line/> : undefined}>
        <CodeTokens text={lines[i] ?? ''} hl={hl} line={i}/>
      </CodeLine>
    );
  }, [lines, hl, range, pick, owner, repo, at]);
  useMarkPainted(at.path);
  return (
    <>
      <FileMeta lines={lines.length} size={entry.size}>{edit}</FileMeta>
      <Lines ref={view} count={lines.length} scroller={scroller} line={line} label={`${at.path}, ${String(lines.length)} lines`} initial={initial}/>
    </>
  );
});

function useLineLinks() {
  const hash = useRouterState({select: (s) => s.location.hash});
  const range = useMemo(() => hashRange(hash), [hash]);
  const navigate = useNavigate();
  const view = useRef<LinesHandle>(null);
  const [initial] = useState(() => range?.[0]);
  useEffect(() => {
    if (range) view.current?.scrollToLine(range[0]);
  }, [range]);
  const pick = useCallback((n: number, extend: boolean) => {
    const from = extend && range ? range[0] + 1 : n;
    const next = from === n ? `L${String(n)}` : `L${String(Math.min(from, n))}-L${String(Math.max(from, n))}`;
    void navigate({to: '.', hash: next, search: true, replace: true});
  }, [navigate, range]);
  return {range, view, initial, pick};
}

/** Record navigation-to-first-paint timing for e2e measurements. */
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

/** GitHub's file header: the view switch and the file's facts, then the raw-file actions and the file's own controls. */
function FileMeta({lines, dims, size, children}: {lines?: number; dims?: string | undefined; size: number | undefined; children?: ReactNode}) {
  const {mode, actions} = use(FileHeader);
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-default bg-muted px-4 py-2 text-sm text-muted tabular-nums">
      {mode}
      {lines !== undefined && <span>{lines} {lines === 1 ? 'line' : 'lines'}</span>}
      {dims && <span>{dims}</span>}
      {size !== undefined && <span>{formatSize(size)}</span>}
      <div className="ml-auto flex items-center gap-2">{actions}{children}</div>
    </div>
  );
}

function ImageFile({bytes, type, path, size}: {bytes: ArrayBuffer; type: string; path: string; size: number | undefined}) {
  const [dims, setDims] = useState<string>();
  return (
    <>
      <FileMeta dims={dims} size={size}/>
      <BlobImage bytes={bytes} type={type} alt={path} onSize={(w, h) => {
        setDims(`${String(w)} × ${String(h)} px`);
      }}/>
    </>
  );
}

const BlameView = observer(function BlameView({owner, repo, repoId, entry, at, text, scroller, edit}: FileProps & {text: string; edit: ReactNode}) {
  const src = useSource();
  const key = `blame:${String(repoId)}:${at.sha}:${at.path}`;
  const blame = useLoad(key, () => src.peek<APIBlame>(key), () => src.blame(repoId, at.sha, at.path));
  const lines = useMemo(() => splitLines(text), [text]);
  const hl = useHighlight(repoId, entry.sha, at.path, text);
  const {range, view, initial, pick} = useLineLinks();
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
      <CodeLine id={`L${String(i + 1)}`} active={range?.[0] === i} linked={range !== undefined && i >= range[0] && i <= range[1]} action={range?.[0] === i ? <FileLinkMenu owner={owner} repo={repo} at={at} line/> : undefined} gutter={<>
        <BlameCell first={first} meta={commit ? ago(commit.authored_at) : undefined}>
          {part && commit && (
            <span title={`${commit.author_name} · ${commit.summary}`} className="flex min-w-0 items-center gap-1">
              <span className="flex w-4 shrink-0 items-center">
                {part.previous_sha && (
                  <CodeLink owner={owner} repo={repo} to={codeSplat('blame', {kind: 'commit', ref: part.previous_sha}, part.previous_path ?? at.path)}
                    className="interactive flex shrink-0 items-center rounded-md text-muted hover:text-default" label="Blame prior to this change">
                    <HistoryIcon size={16} className="shrink-0"/>
                  </CodeLink>
                )}
              </span>
              <span className="max-w-24 shrink-0 truncate text-default @max-xl:hidden">{commit.author_name}</span>
              <CodeLink className="ml-1 min-w-0 truncate text-default hover:text-accent hover:underline" owner={owner} repo={repo} to={`commit/${part.sha}`}>{commit.summary}</CodeLink>
            </span>
          )}
        </BlameCell>
        <LineNo n={i + 1} onPick={pick}/>
      </>}>
        <CodeTokens text={lines[i] ?? ''} hl={hl} line={i}/>
      </CodeLine>
    );
  }, [parts, blame, lines, hl, owner, repo, range, pick, at]);
  if (blame.state !== 'ready') return <Unloaded loaded={blame} what="This blame" skeleton={<CodeSkeleton/>}/>;
  return (
    <>
      <FileMeta lines={lines.length} size={entry.size}>
        {blame.value.uses_ignore_revs && <span>Ignoring the revisions in .git-blame-ignore-revs</span>}
        {edit}
      </FileMeta>
      <Lines ref={view} initial={initial} count={lines.length} scroller={scroller} line={line} label={`Blame of ${at.path}`}/>
    </>
  );
});

export type {Loaded};
