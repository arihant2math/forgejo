// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readSplash, writeSplash, type ThemePreference} from './splash.ts';

const darkQuery = '(prefers-color-scheme: dark)';

export function getThemePreference(): ThemePreference {
  return readSplash().theme ?? 'system';
}

/** Applies a theme by swapping the token set on <html>, and remembers it for the next boot. */
export function setThemePreference(pref: ThemePreference): void {
  writeSplash({theme: pref});
  document.documentElement.dataset.theme = pref === 'system' ?
    (matchMedia(darkQuery).matches ? 'dark' : 'light') :
    pref;
}

/** Follows the OS theme while the preference is "system". Returns an unsubscribe function. */
export function followSystemTheme(): () => void {
  const query = matchMedia(darkQuery);
  const onChange = () => {
    if (getThemePreference() === 'system') document.documentElement.dataset.theme = query.matches ? 'dark' : 'light';
  };
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}
