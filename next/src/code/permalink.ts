// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {encodePath} from './source.ts';

/** Canonical Forgejo file link; the optional line anchor is retained only if valid. */
export function permalink(owner: string, repo: string, sha: string, path: string, hash = ''): string {
  const anchor = hash.replace(/^#/, '');
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/src/commit/${encodeURIComponent(sha)}/${encodePath(path)}${/^L[1-9]\d*(?:-L?[1-9]\d*)?$/.test(anchor) ? `#${anchor}` : ''}`;
}
