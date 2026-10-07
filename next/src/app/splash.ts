// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The splash state: what the first frame should look like, persisted in
// localStorage.splash so the inline boot script (applySplash, inlined into
// index.html by tools/vite-plugin-shell.ts) can apply it before first paint.

export const SPLASH_KEY = 'splash';

export type ThemePreference = 'light' | 'dark' | 'system';
export type SkeletonShape = 'list' | 'detail';

export interface Splash {
  theme?: ThemePreference;
  /** Sidebar width in CSS px; clamped to [SIDEBAR_MIN, SIDEBAR_MAX]. */
  sidebarWidth?: number;
  /** Shape of the last route, so the skeleton matches the page that renders. */
  skeleton?: {shape?: SkeletonShape; rows?: number};
  /**
   * The local DB marker: the id of the user whose IndexedDB exists on this
   * device (F2 writes it). Absent ⇒ the logged-out shell is shown.
   */
  user?: string;
  /** The signed-in user's avatar initial (one or two letters/digits). */
  initial?: string;
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
/** The boot shell renders this many skeleton rows; applySplash hides the rest. */
export const SKELETON_MAX_ROWS = 40;
export const SKELETON_DEFAULT_ROWS = 14;

/**
 * Applies localStorage.splash to <html> and marks appStart. It runs inline in
 * <head>, before <body> is parsed, so it must be self-contained: no imports, no
 * references to anything outside this function (it is inlined via toString()),
 * and it must never throw. The constants above are repeated as literals for
 * that reason; splash.test.ts checks they agree.
 */
export function applySplash(win: Window): void {
  win.performance.mark('appStart');
  const html = win.document.documentElement;
  let s: Splash = {};
  try {
    const parsed: unknown = JSON.parse(win.localStorage.getItem('splash') ?? '{}');
    if (parsed && typeof parsed === 'object') s = parsed;
  } catch {
    // Storage blocked or corrupt: render the defaults.
  }
  const pref = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system';
  html.dataset.theme = pref === 'system' ?
    (win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') :
    pref;
  if (typeof s.sidebarWidth === 'number' && Number.isFinite(s.sidebarWidth)) {
    const w = Math.round(Math.min(480, Math.max(180, s.sidebarWidth)));
    html.style.setProperty('--sidebar-width', `${w}px`);
  }
  html.dataset.shell = typeof s.user === 'string' && s.user ? 'app' : 'logged-out';
  const sk = s.skeleton ?? {};
  html.dataset.skeleton = sk.shape === 'detail' ? 'detail' : 'list';
  const rows = typeof sk.rows === 'number' && Number.isFinite(sk.rows) ?
    Math.round(Math.min(40, Math.max(0, sk.rows))) :
    14;
  const style = win.document.createElement('style');
  style.textContent = `[data-sk-row]:nth-child(n+${rows + 1}){display:none}`;
  win.document.head.append(style);
  if (typeof s.initial === 'string' && /^[\p{L}\p{N}]{1,2}$/u.test(s.initial)) {
    html.style.setProperty('--splash-initial', JSON.stringify(s.initial));
  }
}

/** Reads localStorage.splash; never throws. */
export function readSplash(): Splash {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SPLASH_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Merges patch into localStorage.splash; never throws. */
export function writeSplash(patch: Partial<Splash>): void {
  try {
    localStorage.setItem(SPLASH_KEY, JSON.stringify({...readSplash(), ...patch}));
  } catch {
    // Storage blocked: the next boot uses the defaults.
  }
}
