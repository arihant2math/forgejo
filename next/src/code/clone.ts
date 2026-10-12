// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Requires the instance's public URL with a trailing slash. */
export function httpsCloneUrl(appUrl: string, owner: string, repo: string): string {
  return `${appUrl}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

/** Accepts an SCP or ssh:// prefix; undefined when SSH is disabled. */
export function sshCloneUrl(prefix: string | undefined, owner: string, repo: string): string | undefined {
  return prefix ? `${prefix}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git` : undefined;
}

export type ArchiveFormat = 'zip' | 'tar.gz';

export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = ['zip', 'tar.gz'];

/** Returns a site path for sitePath(); ref slashes stay path separators. */
export function archivePath(owner: string, repo: string, ref: string, format: ArchiveFormat): string {
  const name = ref.split('/').map(encodeURIComponent).join('/');
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${name}.${format}`;
}
