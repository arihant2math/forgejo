// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {useNavigate} from '@tanstack/react-router';
import {untracked} from 'mobx';
import {dismissSeries, notify} from './notices.ts';
import type {App} from './store.ts';

export function goToCode(app: App, navigate: ReturnType<typeof useNavigate>): void {
  const id = untracked(() => app.ui.repoOpen || app.ui.recentRepo);
  const r = id ? app.session?.data.pool.model('Repository').get(id)?.data : undefined;
  if (r) {
    dismissSeries(app, SERIES);
    void navigate({to: '/$owner/$repo/$view/$', params: {owner: r.owner_name, repo: r.name, view: 'src', _splat: ''}});
  } else {
    notify(app, {tone: 'neutral', title: GO_CODE_WHY, description: 'G C opens the code of the repository on screen, or of the last one you opened.', series: SERIES});
  }
}

const SERIES = 'go.code';
export const GO_CODE_WHY = 'Open a repository first';

export function canGoToCode(app: App): boolean {
  const id = untracked(() => app.ui.repoOpen || app.ui.recentRepo);
  return Boolean(id && app.session?.data.pool.model('Repository').get(id));
}
