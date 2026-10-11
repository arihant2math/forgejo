// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, it} from 'vitest';
import {attachmentMarkdown, hasPendingUploads, replaceUpload, stripUploadPlaceholders, uploadPlaceholder} from './attachments.ts';

it('replaces only its placeholder while preserving typing and other concurrent uploads', () => {
  const a = uploadPlaceholder('a', 'screenshot.png');
  const b = uploadPlaceholder('b', 'file.zip');
  const text = `before ${a}\ntyped while uploading ${b} after`;
  const replaced = replaceUpload(text, a, '![screenshot.png](/attachments/a)');
  expect(replaced).toBe(`before ![screenshot.png](/attachments/a)\ntyped while uploading ${b} after`);
  expect(hasPendingUploads(replaced)).toBe(true);
  expect(hasPendingUploads(replaceUpload(replaced, b, '[file.zip](/attachments/b)'))).toBe(false);
});

it('removes failed uploads without deleting text and does not restore deleted placeholders', () => {
  const marker = uploadPlaceholder('a', 'file.zip');
  expect(replaceUpload(`a${marker}b`, marker, '')).toBe('ab');
  expect(replaceUpload('user removed it', marker, '[file.zip](/attachments/a)')).toBe('user removed it');
  expect(stripUploadPlaceholders(`a${marker}b`)).toBe('ab');
});

it('escapes names, distinguishes images, and keeps URLs safe for markdown', () => {
  expect(attachmentMarkdown({name: 'a[b].png', type: 'image/png'}, '/sub/attachments/a')).toBe('![a\\[b\\].png](/sub/attachments/a)');
  expect(attachmentMarkdown({name: 'file.zip', type: 'application/zip'}, '/attachments/a (1)')).toBe('[file.zip](/attachments/a%20%281%29)');
  expect(uploadPlaceholder('a', 'bad-->\n.png')).not.toContain('-->\n');
});
