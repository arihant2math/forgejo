// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {untracked} from 'mobx';
import {openCreate} from '../../app/create.ts';
import type {useApp} from '../../app/store.ts';

/** Prefer the board's repository, or the repository supplying most of its cards. */
export function newIssueIn(app: ReturnType<typeof useApp>, projectId: number, columnId: number, title?: string): void {
  const repoId = untracked(() => {
    const pool = app.session?.data.pool;
    if (!pool) return 0;
    const own = pool.model('Project').get(projectId)?.get('repo_id') ?? 0;
    if (own) return own;
    const count = new Map<number, number>();
    for (const card of pool.model('ProjectIssue').by('project_id', projectId)) {
      const r = pool.model('Issue').get(card.get('issue_id'))?.get('repo_id');
      if (r) count.set(r, (count.get(r) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  });
  openCreate(app, repoId, {projectId, columnId}, title);
}
