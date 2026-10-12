// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Server-rendered markup is cached by blob SHA and passes through the Trusted Types gate.
// The server resolves markup links relative to the file's directory.
// SVGs use blob-backed <img> elements so scripts cannot execute.
import {useEffect, useMemo, useState} from 'react';
import type {RefKind} from '../../code/refs.ts';
import {CodeSource, type FileContent} from '../../code/source.ts';
import type {APITreeEntry} from '../../protocol/types.gen.ts';
import {Markdown} from '../issue/Markdown.tsx';
import {useLoad, useSource} from './hooks.ts';
import {Unloaded} from './states.tsx';
import {BookIcon} from '@primer/octicons-react';
import {SkeletonText} from '@primer/react/experimental';

export function renderable(path: string): 'markup' | 'svg' | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd') return 'markup';
  if (ext === 'svg') return 'svg';
  return undefined;
}

/** Prefer renderable markup READMEs over plain text. */
export function readmeOf<T extends {name: string; type: string}>(entries: readonly T[]): T | undefined {
  const files = entries.filter((e) => e.type === 'blob' && /^readme(?:\.[\w-]+)?$/i.test(e.name));
  return files.find((e) => renderable(e.name) === 'markup') ?? files.find((e) => /^readme(?:\.txt)?$/i.test(e.name));
}

export function RenderedMarkup({repoId, sha, path, text, at}: {repoId: number; sha: string; path: string; text: string; at: {kind: RefKind; ref: string}}) {
  const src = useSource();
  const key = `md2:${String(repoId)}:${sha}:${at.kind}:${at.ref}:${path}`;
  const html = useLoad(key, () => src.peek<string>(key), () => src.rendered(repoId, sha, path, text, {kind: at.kind, name: at.ref}));
  if (html.state !== 'ready') return <Unloaded loaded={html} what="This file's preview" skeleton={<SkeletonText lines={4}/>}/>;
  return <Markdown html={html.value}/>;
}

export function BlobImage({bytes, type, alt, onSize}: {bytes: ArrayBuffer | string; type: string; alt: string; onSize?: (w: number, h: number) => void}) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], {type})), [bytes, type]);
  useEffect(() => () => {
    URL.revokeObjectURL(url);
  }, [url]);
  const [small, setSmall] = useState(false);
  // Checkerboards reveal transparency on either theme; enlarge tiny images with sharp pixels.
  return (
    <div className="flex justify-center p-6">
      <img src={url} alt={alt} className={small ? 'pixelated bg-checker w-auto max-w-full border border-muted' : 'bg-checker max-w-full border border-muted'}
        style={small ? {zoom: SMALL_ZOOM} : undefined}
        onLoad={(e) => {
          const {naturalWidth: w, naturalHeight: h} = e.currentTarget;
          setSmall(w > 0 && h > 0 && w <= SMALL_IMAGE && h <= SMALL_IMAGE);
          onSize?.(w, h);
        }}/>
    </div>
  );
}

const SMALL_IMAGE = 64;
const SMALL_ZOOM = 4;

/** Stable anchor for the repository About panel's README link. */
export const README_ID = 'readme';

export function ReadmePanel({repoId, entry, dir, at}: {repoId: number; entry: APITreeEntry; dir: string; at: {kind: RefKind; ref: string; sha: string}}) {
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  const body = renderable(entry.name) === 'markup' ?
    <RenderedAt repoId={repoId} commit={at.sha} path={path} at={at}/> :
    <PlainReadme repoId={repoId} entry={entry} path={path}/>;
  return <section id={README_ID} aria-label="README" className="rounded-md border border-default"><div className="flex items-center gap-2 border-b border-default min-h-10 rounded-t-md bg-muted px-4 py-2 text-base font-semibold"><BookIcon size={16}/>{entry.name}</div><div className="p-4">{body}</div></section>;
}

function RenderedAt({repoId, commit, path, at}: {repoId: number; commit: string; path: string; at: {kind: RefKind; ref: string}}) {
  const src = useSource();
  const ref = {kind: at.kind, name: at.ref};
  const key = CodeSource.renderedKey(repoId, commit, path, ref);
  const html = useLoad(key, () => src.peek<string>(key), () => src.renderedAt(repoId, commit, path, ref));
  if (html.state !== 'ready') return <Unloaded loaded={html} what="The README" skeleton={<SkeletonText lines={6}/>}/>;
  return <Markdown html={html.value}/>;
}

function PlainReadme({repoId, entry, path}: {repoId: number; entry: APITreeEntry; path: string}) {
  const src = useSource();
  const key = CodeSource.blobKey(repoId, entry.sha);
  const blob = useLoad(key, () => src.peek<FileContent>(key), () => src.blob(repoId, entry.sha, path, entry.size));
  if (blob.state !== 'ready') return <Unloaded loaded={blob} what="The README" skeleton={<SkeletonText lines={6}/>}/>;
  if (blob.value.kind !== 'text') return <p className="text-base text-muted">The README is not a text file.</p>;
  return <pre className="font-mono text-base whitespace-pre-wrap text-default">{blob.value.text}</pre>;
}
