// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ADD, DEL, type DiffFile} from './diff.ts';

/** Preserve the server's hunk coordinates: never diff two truncated file bodies. */
export function pierrePatch(file: DiffFile): string {
  const old = JSON.stringify(`a/${file.oldPath}`);
  const next = JSON.stringify(`b/${file.newPath}`);
  const out = [`diff --git ${old} ${next}`];
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) out.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`);
  if (file.status === 'added') out.push(`new file mode ${file.newMode ?? '100644'}`);
  if (file.status === 'deleted') out.push(`deleted file mode ${file.oldMode ?? '100644'}`);
  if (file.status === 'renamed' || file.status === 'copied') {
    out.push(`${file.status === 'copied' ? 'copy' : 'rename'} from ${JSON.stringify(file.oldPath)}`);
    out.push(`${file.status === 'copied' ? 'copy' : 'rename'} to ${JSON.stringify(file.newPath)}`);
  }
  out.push(`--- ${file.status === 'added' ? '/dev/null' : old}`, `+++ ${file.status === 'deleted' ? '/dev/null' : next}`);
  if (file.binary) out.push('Binary files differ');
  for (const h of file.hunks) {
    out.push(`@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@ ${h.section}`);
    for (const l of file.lines.slice(h.first, h.first + h.count)) {
      out.push(`${l.k === ADD ? '+' : l.k === DEL ? '-' : ' '}${l.t}`);
      if (l.noEol) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}
