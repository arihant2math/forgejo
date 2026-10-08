// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Transient notices (bottom right): a change the server refused and that was
// rolled back, and the like. Any code with the App can post one; the shell
// renders them (NoticeHost, its own chunk, loaded when the first one shows).

import {runInAction} from 'mobx';
import type {NoticeTone} from '../ui/Notice.tsx';
import type {App} from './store.ts';

export interface NoticeSpec {
  id: number;
  tone: NoticeTone;
  title: string;
  description?: string;
  /** One action button (Retry). Running it dismisses the notice. */
  action?: {label: string; run: () => void};
  /** Fading out. */
  closing?: boolean;
}

/** Notices shown at once; older ones go first. */
const MAX = 4;
/** How long a notice stays (ms); danger notices stay twice as long. */
const TTL = 8000;

let seq = 0;

export function notify(app: App, spec: Omit<NoticeSpec, 'id' | 'closing'>): number {
  const id = ++seq;
  runInAction(() => {
    app.ui.notices.push({...spec, id});
    while (app.ui.notices.length > MAX) app.ui.notices.shift();
  });
  setTimeout(() => {
    dismiss(app, id);
  }, spec.tone === 'danger' ? 2 * TTL : TTL);
  return id;
}

/** Starts a notice's exit (it fades out, then `removeNotice`). */
export function dismiss(app: App, id: number): void {
  runInAction(() => {
    const i = app.ui.notices.findIndex((n) => n.id === id);
    const n = app.ui.notices[i];
    if (n && !n.closing) app.ui.notices[i] = {...n, closing: true};
  });
  // Without an exit animation (reduced motion) no animationend arrives.
  setTimeout(() => {
    removeNotice(app, id);
  }, 400);
}

export function removeNotice(app: App, id: number): void {
  runInAction(() => {
    const i = app.ui.notices.findIndex((n) => n.id === id);
    if (i >= 0) app.ui.notices.splice(i, 1);
  });
}
