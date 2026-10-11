// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {parsePatchFiles} from '@pierre/diffs';
import {pierrePatch} from '../code/pierrePatch.ts';
import type {DiffFile} from '../code/diff.ts';

self.onmessage = (event: MessageEvent<readonly DiffFile[]>) => {
  try {
    const files = event.data.map((file) => {
      const parsed = parsePatchFiles(pierrePatch(file))[0]?.files[0];
      if (!parsed) throw new Error('Unrecognized patch');
      // The API already decoded Git C-quoted paths. Do not decode them twice.
      parsed.name = file.status === 'deleted' ? file.oldPath : file.newPath;
      if (file.status === 'renamed' || file.status === 'copied') parsed.prevName = file.oldPath;
      return parsed;
    });
    self.postMessage({files});
  } catch {
    self.postMessage({error: true});
  }
};
