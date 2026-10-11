// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {parseDiff} from '../../code/diff.ts';
import {isImageDiff} from './ImageDiff.tsx';

describe('image diffs', () => {
  it('recognizes modified and deleted binary images, but not other binary files', () => {
    const files = parseDiff('diff --git a/photo.PNG b/photo.PNG\nBinary files a/photo.PNG and b/photo.PNG differ\ndiff --git a/old.gif b/old.gif\ndeleted file mode 100644\nBinary files a/old.gif and /dev/null differ\ndiff --git a/archive.zip b/archive.zip\nBinary files a/archive.zip and b/archive.zip differ\n');
    expect(files.map(isImageDiff)).toEqual([true, true, false]);
  });
});
