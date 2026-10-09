// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Files shown rendered (a README under a directory, a markdown file's
// "Preview", an SVG as an image): markup is rendered by Forgejo (B9
// /-/sync/api/markup, as its file page does: links resolve from the file's directory;
// cached by blob SHA, so it is there offline once seen) and put in
// through the Trusted Types gate; an SVG is shown as an image (an <img> from
// a blob: URL runs no script).

import {BookOpen} from 'lucide-react';
import {useEffect, useMemo} from 'react';
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
export function BlobImage({bytes, type, alt}: {bytes: ArrayBuffer | string; type: string; alt: string}) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], {type})), [bytes, type]);
  useEffect(() => () => {
    URL.revokeObjectURL(url);
  }, [url]);
  return <div className="flex justify-center p-6"><img src={url} alt={alt} className="max-w-full"/></div>;
}

/** A directory's README as a panel: rendered markup, or the text as is. */
export function ReadmePanel({repoId, entry, dir, at}: {repoId: number; entry: APITreeEntry; dir: string; at: {kind: RefKind; ref: string}}) {
  const src = useSource();
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  const key = CodeSource.blobKey(repoId, entry.sha);
  const blob = useLoad(key, () => src.peek<FileContent>(key), () => src.blob(repoId, entry.sha, path, entry.size));
  let body;
  if (blob.state !== 'ready') body = <Unloaded loaded={blob} what="The README" skeleton={<SkeletonText lines={6}/>}/>;
  else if (blob.value.kind !== 'text') body = <p className="text-base text-fg-muted">The README is not a text file.</p>;
  else if (renderable(entry.name) === 'markup') body = <RenderedMarkup repoId={repoId} sha={entry.sha} path={path} text={blob.value.text} at={at}/>;
  else body = <pre className="font-mono text-code whitespace-pre-wrap text-fg">{blob.value.text}</pre>;
  return <Panel label="README" title={<><Icon icon={BookOpen} size="sm"/>{entry.name}</>} padded>{body}</Panel>;
}
