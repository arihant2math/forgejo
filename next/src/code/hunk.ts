// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The lines of a review comment's hunk (Forgejo's comment.patch, kept with the comment): the code it is about,
// without the git headers (`diff --git`, `index`, `---`, `+++`) and the hunk headers (`@@ -58,3 +56,13 @@ func …`,
// with or without the function context). Pure.

/** The diff lines of a stored hunk (each starts with " ", "+" or "-"), the last `max` of them. */
export function hunkLines(patch: string, max: number): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    // Before the first hunk header: the file's headers. Inside: only diff lines ("\ No newline" is a note).
    if (!inHunk || l === '' || l.startsWith('\\')) continue;
    if (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-')) out.push(l);
  }
  // A patch without any hunk header (an old comment): its diff lines, if they are diff lines.
  if (!inHunk) {
    for (const l of patch.split('\n')) if (/^[ +-]/.test(l) && !/^(?:\+\+\+|---) /.test(l)) out.push(l);
  }
  return out.slice(-max);
}
