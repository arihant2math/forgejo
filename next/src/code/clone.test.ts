// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {archivePath, httpsCloneUrl, sshCloneUrl} from './clone.ts';

describe('the clone URLs and archives', () => {
  test('HTTPS from the public URL; SSH from the instance\'s prefix, none without one', () => {
    expect(httpsCloneUrl('https://code.example/git/', 'acme', 'web site')).toBe('https://code.example/git/acme/web%20site.git');
    expect(sshCloneUrl('git@code.example:', 'acme', 'website')).toBe('git@code.example:acme/website.git');
    expect(sshCloneUrl('ssh://git@code.example:2222/', 'acme', 'website')).toBe('ssh://git@code.example:2222/acme/website.git');
    expect(sshCloneUrl(undefined, 'acme', 'website')).toBeUndefined();
    expect(sshCloneUrl('', 'acme', 'website')).toBeUndefined();
  });
  test('archives by ref: slashes stay separators, each segment encoded', () => {
    expect(archivePath('acme', 'website', 'main', 'zip')).toBe('/acme/website/archive/main.zip');
    expect(archivePath('acme', 'website', 'feature/a b', 'tar.gz')).toBe('/acme/website/archive/feature/a%20b.tar.gz');
  });
});
