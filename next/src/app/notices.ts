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
/** How long a notice stays (ms) while not hovered or focused; danger notices twice as long. */
const TTL = 8000;

let seq = 0;
const timers = new Map<number, {left: number; started: number; timer: ReturnType<typeof setTimeout> | undefined}>();

/**
 * Posts a notice. It leaves on its own after a while (paused while the pointer or focus is on it),
 * except a danger notice with an action (Retry), which stays until dismissed.
 */
export function notify(app: App, spec: Omit<NoticeSpec, 'id' | 'closing'>): number {
  const id = ++seq;
  runInAction(() => {
    app.ui.notices.push({...spec, id});
    while (app.ui.notices.length > MAX) {
      const old = app.ui.notices.shift();
      if (old) timers.delete(old.id);
    }
  });
  if (!(spec.tone === 'danger' && spec.action)) {
    timers.set(id, {left: spec.tone === 'danger' ? 2 * TTL : TTL, started: 0, timer: undefined});
    resumeNotice(app, id);
  }
  return id;
}

/** The pointer or focus is on the notice: its time stops. */
export function pauseNotice(id: number): void {
  const t = timers.get(id);
  if (!t?.timer) return;
  clearTimeout(t.timer);
  t.timer = undefined;
  t.left -= Date.now() - t.started;
}

/** Its time runs again. */
export function resumeNotice(app: App, id: number): void {
  const t = timers.get(id);
  if (!t || t.timer) return;
  t.started = Date.now();
  t.timer = setTimeout(() => {
    dismiss(app, id);
  }, Math.max(1000, t.left));
}

/** Starts a notice's exit (it fades out, then `removeNotice`). */
export function dismiss(app: App, id: number): void {
  const t = timers.get(id);
  if (t?.timer) clearTimeout(t.timer);
  timers.delete(id);
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
