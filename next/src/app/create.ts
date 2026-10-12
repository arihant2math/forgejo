// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction} from 'mobx';
import type {App} from './store.ts';

/** Uses the given repo, then the current or last-used repo; never selects an arbitrary repository.
 * `board` places the issue in that column; `title` pre-fills the dialog.
 */
export function openCreate(app: App, repoId = 0, board?: {projectId: number; columnId: number}, title?: string): void {
  runInAction(() => {
    app.ui.create = {repoId: repoId || app.ui.repoOpen || app.ui.recentRepo || 0, ...(board ? {board} : {}), ...(title?.trim() ? {title: title.trim()} : {})};
  });
}
