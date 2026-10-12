// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useState} from 'react';
import type {DiffFile} from '../../code/diff.ts';
import {useSource} from './hooks.ts';

export function isImageDiff(file: DiffFile): boolean {
  return file.binary && /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(file.newPath || file.oldPath);
}

export function ImageDiff({repoId, base, head, file}: {repoId: number; base: string; head: string; file: DiffFile}) {
  return <div className="sticky left-0 flex w-view flex-wrap gap-4 p-4 font-sans text-base">
    {file.status !== 'added' && <ImageSide key={`${String(repoId)}:${base}:${file.oldPath}`} repoId={repoId} commit={base} path={file.oldPath} label="Before"/>}
    {file.status !== 'deleted' && <ImageSide key={`${String(repoId)}:${head}:${file.newPath}`} repoId={repoId} commit={head} path={file.newPath} label="After"/>}
  </div>;
}

function ImageSide({repoId, commit, path, label}: {repoId: number; commit: string; path: string; label: string}) {
  const source = useSource();
  const [image, setImage] = useState<{url: string; size: number} | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState('');
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void source.raw(repoId, commit, path).then((content) => {
      if (!active) return;
      if (content.kind !== 'image') {
        setFailed(true);
        return;
      }
      url = URL.createObjectURL(new Blob([content.bytes], {type: content.type}));
      setImage({url, size: content.size});
    }, () => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, repoId, commit, path]);
  return <figure className="min-w-0 flex-1">
    <figcaption className="mb-2 text-sm text-muted">{label}{image && ` · ${String(image.size)} bytes`}{dimensions && ` · ${dimensions}`}</figcaption>
    {image ? <img src={image.url} alt={`${label}: ${path}`} className="max-h-80 max-w-full object-contain" onLoad={(event) => {
      setDimensions(`${String(event.currentTarget.naturalWidth)} × ${String(event.currentTarget.naturalHeight)}`);
    }} onError={() => {
      setImage(undefined);
      setFailed(true);
    }}/> : <p className="text-muted">{failed ? 'Image preview unavailable.' : 'Loading image…'}</p>}
  </figure>;
}
