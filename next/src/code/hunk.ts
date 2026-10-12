// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The diff lines of a stored hunk (each starts with " ", "+" or "-"), the last `max` of them. */
export function hunkLines(patch: string, max: number): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || l === '' || l.startsWith('\\')) continue;
    if (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-')) out.push(l);
  }
  // Stored comment patches may omit hunk headers.
  if (!inHunk) {
    for (const l of patch.split('\n')) if (/^[ +-]/.test(l) && !/^(?:\+\+\+|---) /.test(l)) out.push(l);
  }
  return out.slice(-max);
}
