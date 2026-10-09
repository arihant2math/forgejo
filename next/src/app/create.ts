// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Opening the new-issue dialog (C, the palette, "New issue" buttons): in the
// repository on screen, else the one last used. The dialog is its own chunk
// (features/create), mounted by the shell from its first use on.

import {runInAction} from 'mobx';
import type {App} from './store.ts';

/** `board`: the new issue goes on that board, in that column (a board column's "New issue"). */
export function openCreate(app: App, repoId = 0, board?: {projectId: number; columnId: number}): void {
  runInAction(() => {
    app.ui.create = {repoId: repoId || app.ui.repoOpen || 0, ...(board ? {board} : {})};
  });
}
