// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observable, runInAction} from 'mobx';
import {readSplash, SPLASH_KEY, writeSplash, type ThemePreference} from './splash.ts';

const darkQuery = '(prefers-color-scheme: dark)';

export function getThemePreference(): ThemePreference {
  return readSplash().theme ?? 'system';
}

export const themeState = observable({preference: getThemePreference()});

/** Persists the preference for the next boot. */
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

function applyMode(mode: 'light' | 'dark'): void {
  const html = document.documentElement;
  html.dataset.theme = mode;
  html.dataset.colorMode = mode;
}

/** Follows OS and cross-tab preferences; returns listener cleanup. */
export function followSystemTheme(): () => void {
  const query = matchMedia(darkQuery);
  const onChange = () => {
    if (getThemePreference() === 'system') applyMode(query.matches ? 'dark' : 'light');
  };
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
