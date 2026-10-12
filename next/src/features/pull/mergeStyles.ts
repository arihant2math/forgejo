// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {MERGE_STYLES, pullSettingsOf} from '../settings/forms.ts';

export function mergeOptions(config: Readonly<Record<string, unknown>>) {
  const settings = pullSettingsOf(config);
  const styles = MERGE_STYLES.filter((m) => m.style !== 'manually-merged' && settings.allowed[m.style]);
  const primary = styles.find((m) => m.style === settings.defaultStyle) ?? styles[0];
  return {styles, primary, rebaseUpdate: settings.rebaseUpdate};
}
