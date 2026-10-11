// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observable, runInAction} from 'mobx';
import {readSplash, SPLASH_KEY, writeSplash, type ThemePreference} from './splash.ts';

const darkQuery = '(prefers-color-scheme: dark)';

export function getThemePreference(): ThemePreference {
  return readSplash().theme ?? 'system';
}

/** The preference, observable: every control showing it follows every change (menu, palette, gallery). */
export const themeState = observable({preference: getThemePreference()});

/** Applies a theme by swapping the token set on <html>, and remembers it for the next boot. */
export function setThemePreference(pref: ThemePreference): void {
  writeSplash({theme: pref});
  showTheme(pref);
}

function showTheme(pref: ThemePreference): void {
  runInAction(() => {
    themeState.preference = pref;
  });
  applyMode(pref === 'system' ? (matchMedia(darkQuery).matches ? 'dark' : 'light') : pref);
}

/** Shows a colour mode: Primer's themes key on data-color-mode (data-light-theme / data-dark-theme are set in index.html). */
function applyMode(mode: 'light' | 'dark'): void {
  const html = document.documentElement;
  html.dataset.theme = mode;
  html.dataset.colorMode = mode;
}

/** Follows the OS theme while the preference is "system", and the preference set in other tabs. Returns an unsubscribe function. */
export function followSystemTheme(): () => void {
  const query = matchMedia(darkQuery);
  const onChange = () => {
    if (getThemePreference() === 'system') applyMode(query.matches ? 'dark' : 'light');
  };
  // Another tab changed the preference (QA round 2): every open tab shows it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SPLASH_KEY && e.key !== null) return;
    const pref = getThemePreference();
    if (pref !== themeState.preference) showTheme(pref);
  };
  query.addEventListener('change', onChange);
  addEventListener('storage', onStorage);
  return () => {
    query.removeEventListener('change', onChange);
    removeEventListener('storage', onStorage);
  };
}
