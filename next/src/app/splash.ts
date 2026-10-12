// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Persisted splash state is applied by the inline boot script before first paint.

export const SPLASH_KEY = 'splash';

export type ThemePreference = 'light' | 'dark' | 'system';
export type SkeletonShape = 'list' | 'detail';
/** `page`: one row; `tabs`: breadcrumb and tabs; `toolbar`: adds a title/control row. */
export type SkeletonHeader = 'page' | 'tabs' | 'toolbar';

export interface Splash {
  theme?: ThemePreference;
  /** Sidebar width in CSS px; clamped to [SIDEBAR_MIN, SIDEBAR_MAX]. */
  sidebarWidth?: number;
  sidebarHidden?: boolean;
  skeleton?: {shape?: SkeletonShape; rows?: number; header?: SkeletonHeader};
  /** User id marking a local IndexedDB; absent shows the logged-out shell. */
  user?: string;
  initial?: string;
  /** Site path and query resumed at the app's base URL. */
  route?: string;
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SKELETON_MAX_ROWS = 40;
export const SKELETON_DEFAULT_ROWS = 14;

/** Inlined via toString() before body parsing: must be self-contained and never throw.
 * Constants are repeated as literals; tests verify they agree.
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
  // Primer reads data-color-mode; app checks read the matching data-theme.
  html.dataset.theme = html.dataset.colorMode = pref === 'system' ?
    (win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') :
    pref;
  if (typeof s.sidebarWidth === 'number' && Number.isFinite(s.sidebarWidth)) {
    const w = Math.round(Math.min(480, Math.max(180, s.sidebarWidth)));
    html.style.setProperty('--sidebar-width', `${w}px`);
  }
  if (s.sidebarHidden === true) html.dataset.sidebar = 'hidden';
  html.dataset.shell = typeof s.user === 'string' && s.user ? 'app' : 'logged-out';
  const sk = s.skeleton ?? {};
  html.dataset.skeleton = sk.shape === 'detail' ? 'detail' : 'list';
  html.dataset.header = sk.header === 'tabs' || sk.header === 'toolbar' ? sk.header : 'page';
  const rows = typeof sk.rows === 'number' && Number.isFinite(sk.rows) ?
    Math.round(Math.min(40, Math.max(0, sk.rows))) :
    14;
  const style = win.document.createElement('style');
  style.textContent = `[data-sk-row]:nth-child(n+${rows + 1}){display:none}`;
  win.document.head.append(style);
  if (typeof s.initial === 'string' && /^[\p{L}\p{N}]{1,2}$/u.test(s.initial)) {
    html.style.setProperty('--splash-initial', JSON.stringify(s.initial));
  }
  // Capture sign-in clicks before React loads; LoggedOut replays them.
  win.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-early="signin"]') : null;
    if (!t || html.dataset.ready === '1') return;
    html.dataset.early = 'signin';
    t.setAttribute('aria-busy', 'true');
    t.textContent = 'Signing in…';
  }, true);
}

export const EARLY_SIGN_IN = 'signin';

export function hasUser(s: Splash): boolean {
  return typeof s.user === 'string' && s.user !== '';
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

export function forgetRoute(): void {
  try {
    const {route: _route, ...rest} = readSplash();
    localStorage.setItem(SPLASH_KEY, JSON.stringify(rest));
  } catch {
    // Storage blocked.
  }
}

/** User-specific preferences cleared at sign-out. */
export const LOCAL_PREFS = ['forgejo-next:sidebar', 'forgejo-next:board', 'forgejo-next:views', 'forgejo-next:home'] as const;

/** Clears the local user marker and preferences so the next boot shows the logged-out shell. */
export function forgetUser(): void {
  try {
    const {user: _user, initial: _initial, route: _route, ...rest} = readSplash();
    localStorage.setItem(SPLASH_KEY, JSON.stringify(rest));
  } catch {
    // Storage blocked.
  }
}
