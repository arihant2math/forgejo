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
  /** Stays until dismissed or acted on (an update ready to load). */
  sticky?: boolean;
  /** Fading out. */
  closing?: boolean;
  /**
   * Notices of a series (the inbox's triage, closing and reopening): a new one replaces the one shown, so there is
   * one Undo, for the latest action (Linear).
   */
  series?: string;
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
  if (spec.action?.label === 'Undo') spec = {...spec, action: undoable(app, id, spec.action.run)};
  runInAction(() => {
    // The same series, or the same words: the new notice replaces the old one (one notice per message: a refusal
    // repeated by a second attempt does not stack).
    const same = (old: NoticeSpec) => (spec.series ? old.series === spec.series :
      old.tone === spec.tone && old.title === spec.title && old.description === spec.description);
    for (let i = app.ui.notices.length - 1; i >= 0; i--) {
      const old = app.ui.notices[i];
      if (!old || !same(old)) continue;
      const t = timers.get(old.id);
      if (t?.timer) clearTimeout(t.timer);
      timers.delete(old.id);
      app.ui.notices.splice(i, 1);
    }
    app.ui.notices.push({...spec, id});
    while (app.ui.notices.length > MAX) {
      const old = app.ui.notices.shift();
      if (old) timers.delete(old.id);
    }
  });
  if (!spec.sticky && !(spec.tone === 'danger' && spec.action)) {
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

/** Dismisses the notices of a series (what they said no longer holds: "Open a repository first" once one is open). */
export function dismissSeries(app: App, series: string): void {
  for (const n of app.ui.notices) if (n.series === series) dismiss(app, n.id);
}

/** Changes that can be undone, latest last (each notice with Undo): ⌘Z / Ctrl+Z undoes the latest. */
const undos: {id: number; run: () => void}[] = [];
const MAX_UNDOS = 20;

/** The notice's Undo, also kept for ⌘Z (an Undo run either way is run once). */
function undoable(app: App, id: number, run: () => void): {label: string; run: () => void} {
  const entry = {id, run};
  undos.push(entry);
  if (undos.length > MAX_UNDOS) undos.shift();
  return {label: 'Undo', run: () => {
    const i = undos.indexOf(entry);
    if (i < 0) return;
    undos.splice(i, 1);
    dismiss(app, id);
    run();
  }};
}

/** Undoes the latest change that can be undone (⌘Z / Ctrl+Z outside text fields); says so when there is none. */
export function undoLatest(app: App): void {
  const last = undos.pop();
  if (!last) {
    notify(app, {tone: 'neutral', title: 'Nothing to undo', series: 'undo'});
    return;
  }
  dismiss(app, last.id);
  last.run();
}
