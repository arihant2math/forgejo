// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, test} from 'vitest';
import {editableText, EDIT_MAX, updateFileBody} from './fileWrite.ts';

describe('file edits', () => {
  test('builds a UTF-8 update with the original blob and branch', () => {
    const body = updateFileBody('héllo 🌍\n', 'blob', 'main', ' Update README ', ' Details ');
    expect(new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)))).toBe('héllo 🌍\n');
    expect(body).toMatchObject({sha: 'blob', branch: 'main', message: 'Update README\n\nDetails'});
    expect(body).not.toHaveProperty('new_branch');
    expect(updateFileBody('', 'blob', 'main', 'Update', '', ' docs ')).toMatchObject({content: '', new_branch: 'docs', message: 'Update'});
  });
  test('rejects LFS pointers and oversized UTF-8 content', () => {
    expect(editableText('')).toBe(true);
    expect(editableText('version https://git-lfs.github.com/spec/v1\noid sha256:123')).toBe(false);
    expect(editableText('é'.repeat(EDIT_MAX))).toBe(false);
  });
});
