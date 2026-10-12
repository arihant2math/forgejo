// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction} from 'mobx';
import type {App} from './store.ts';

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface NoticeSpec {
  id: number;
  tone: NoticeTone;
  title: string;
  description?: string;
  /** One action button (Retry). Running it dismisses the notice. */
  action?: {label: string; run: () => void};
  /** Stays until dismissed or acted on (an update ready to load). */
  sticky?: boolean;
  /** Replaces the previous notice in this series, keeping only the latest Undo. */
  series?: string;
}

const MAX = 4;
/** How long a notice stays (ms) while not hovered or focused; danger notices twice as long. */
const TTL = 8000;

let seq = 0;
const timers = new Map<number, {left: number; started: number; timer: ReturnType<typeof setTimeout> | undefined}>();

/** Auto-dismisses with hover/focus pauses; danger notices with actions stay until dismissed. */
export function notify(app: App, spec: Omit<NoticeSpec, 'id'>): number {
  const id = ++seq;
  if (spec.action?.label === 'Undo') spec = {...spec, action: undoable(app, id, spec.title, spec.action.run)};
  runInAction(() => {
    // Coalesce repeated refusals instead of stacking them.
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

export function pauseNotice(id: number): void {
  const t = timers.get(id);
  if (!t?.timer) return;
  clearTimeout(t.timer);
  t.timer = undefined;
  t.left -= Date.now() - t.started;
}

export function resumeNotice(app: App, id: number): void {
  const t = timers.get(id);
  if (!t || t.timer) return;
  t.started = Date.now();
  t.timer = setTimeout(() => {
    dismiss(app, id);
  }, Math.max(1000, t.left));
}

export function dismiss(app: App, id: number): void {
  removeNotice(app, id);
}

export function removeNotice(app: App, id: number): void {
  const t = timers.get(id);
  if (t?.timer) clearTimeout(t.timer);
  timers.delete(id);
  runInAction(() => {
    const i = app.ui.notices.findIndex((n) => n.id === id);
    if (i >= 0) app.ui.notices.splice(i, 1);
  });
}

export function dismissSeries(app: App, series: string): void {
  for (const n of app.ui.notices) if (n.series === series) dismiss(app, n.id);
}

const undos: {id: number; app: App; title: string; run: () => void}[] = [];
const MAX_UNDOS = 20;

/** Undo runs at most once, whether invoked from the notice or keyboard. */
function undoable(app: App, id: number, title: string, run: () => void): {label: string; run: () => void} {
  const entry = {id, app, title, run};
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

/** Undoes the latest change; posts a notice when none is available. */
export function undoLatest(app: App): void {
  const index = undos.findLastIndex((entry) => entry.app === app);
  const last = index < 0 ? undefined : undos.splice(index, 1)[0];
  if (!last) {
    notify(app, {tone: 'neutral', title: 'Nothing to undo', series: 'undo'});
    return;
  }
  dismiss(app, last.id);
  last.run();
  notify(app, {tone: 'neutral', title: `Undid: ${last.title}`, series: 'undo'});
}
