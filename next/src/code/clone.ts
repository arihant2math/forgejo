// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's clone URLs and source archives, as Forgejo composes them
// (models/repo ComposeHTTPSCloneURL / ComposeSSHCloneURL, the classic
// `/{owner}/{repo}/archive/{ref}.{zip,tar.gz}` route). Pure.

/** The clone URL over HTTP(S): Forgejo's public URL (ending in "/") + "owner/repo.git". */
export function httpsCloneUrl(appUrl: string, owner: string, repo: string): string {
  return `${appUrl}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

/**
 * The clone URL over SSH from the instance's prefix (NextConfig.ssh_clone_prefix: "git@host:" or
 * "ssh://git@host:2222/"), or undefined when the instance has SSH off (no prefix).
 */
export function sshCloneUrl(prefix: string | undefined, owner: string, repo: string): string | undefined {
  return prefix ? `${prefix}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git` : undefined;
}

export type ArchiveFormat = 'zip' | 'tar.gz';

export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = ['zip', 'tar.gz'];

/**
 * The site path (without the instance's sub-path: pass it through sitePath) of a ref's source archive. A ref's
 * slashes stay path separators ("feature/x" → ".../archive/feature/x.zip"), each segment encoded.
 */
export function archivePath(owner: string, repo: string, ref: string, format: ArchiveFormat): string {
  const name = ref.split('/').map(encodeURIComponent).join('/');
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/${name}.${format}`;
}
