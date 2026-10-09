// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Files shown rendered (a README under a directory, a markdown file's
// "Preview", an SVG as an image): markup is rendered by Forgejo (B9
// /-/sync/api/markup, as its file page does: links resolve from the file's directory;
// cached by blob SHA, so it is there offline once seen) and put in
// through the Trusted Types gate; an SVG is shown as an image (an <img> from
// a blob: URL runs no script).

import {BookOpen} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';
import type {RefKind} from '../../code/refs.ts';
import {CodeSource, type FileContent} from '../../code/source.ts';
import type {APITreeEntry} from '../../protocol/types.gen.ts';
import {Icon, Panel, SkeletonText} from '../../ui/index.ts';
import {Markdown} from '../issue/Markdown.tsx';
import {useLoad, useSource} from './hooks.ts';
import {Unloaded} from './states.tsx';

/** Whether a file has a rendered view ("Preview"): markdown (and other markup Forgejo renders), SVG images. */
export function renderable(path: string): 'markup' | 'svg' | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd') return 'markup';
  if (ext === 'svg') return 'svg';
  return undefined;
}

/** The README of a directory's entries (README.md first), if any. */
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

/** An image file (raster, or an SVG's text) shown from a blob: URL. */
export function BlobImage({bytes, type, alt, onSize}: {bytes: ArrayBuffer | string; type: string; alt: string; onSize?: (w: number, h: number) => void}) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], {type})), [bytes, type]);
  useEffect(() => () => {
    URL.revokeObjectURL(url);
  }, [url]);
  const [small, setSmall] = useState(false);
  // On a checkerboard (transparent parts show, a white or black image is seen on either theme); a tiny image (an icon)
  // is shown four times larger with sharp pixels, not as a speck (QA verify3: a 16×16 PNG looked blank).
  return (
    <div className="flex justify-center p-6">
      <img src={url} alt={alt} className={small ? 'pixelated bg-checker w-auto max-w-full border border-border-subtle' : 'bg-checker max-w-full border border-border-subtle'}
        style={small ? {zoom: SMALL_ZOOM} : undefined}
        onLoad={(e) => {
          const {naturalWidth: w, naturalHeight: h} = e.currentTarget;
          setSmall(w > 0 && h > 0 && w <= SMALL_IMAGE && h <= SMALL_IMAGE);
          onSize?.(w, h);
        }}/>
    </div>
  );
}

/** An image at most this large (px) is shown enlarged SMALL_ZOOM times. */
const SMALL_IMAGE = 64;
const SMALL_ZOOM = 4;

/**
 * A directory's README as a panel: rendered markup (the server reads and renders it at the commit: one round trip,
 * no blob first), or the text as is.
 */
export function ReadmePanel({repoId, entry, dir, at}: {repoId: number; entry: APITreeEntry; dir: string; at: {kind: RefKind; ref: string; sha: string}}) {
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  const body = renderable(entry.name) === 'markup' ?
    <RenderedAt repoId={repoId} commit={at.sha} path={path} at={at}/> :
    <PlainReadme repoId={repoId} entry={entry} path={path}/>;
  return <Panel label="README" title={<><Icon icon={BookOpen} size="sm"/>{entry.name}</>} padded>{body}</Panel>;
}

/** A markup file at a commit, rendered by the server from the repository (renderedAt). */
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
  if (blob.value.kind !== 'text') return <p className="text-base text-fg-muted">The README is not a text file.</p>;
  return <pre className="font-mono text-code whitespace-pre-wrap text-fg">{blob.value.text}</pre>;
}
