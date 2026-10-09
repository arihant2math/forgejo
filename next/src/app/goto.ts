// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// "Go to the code" (G C, the palette): the repository on screen, else the one last opened in this tab; with
// none, a notice says what to do (a shortcut listed under General never does nothing silently).

import type {useNavigate} from '@tanstack/react-router';
import {untracked} from 'mobx';
import {notify} from './notices.ts';
import type {App} from './store.ts';

export function goToCode(app: App, navigate: ReturnType<typeof useNavigate>): void {
  const id = untracked(() => app.ui.repoOpen || app.ui.recentRepo);
  const r = id ? app.session?.data.pool.model('Repository').get(id)?.data : undefined;
  if (r) void navigate({to: '/-/next/code/$owner/$repo/$', params: {owner: r.owner_name, repo: r.name, _splat: 'src/-'}});
  else notify(app, {tone: 'neutral', title: 'Open a repository first', description: 'G C opens the code of the repository on screen, or of the last one you opened.'});
}
