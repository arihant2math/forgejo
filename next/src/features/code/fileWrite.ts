// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export const EDIT_MAX = 512 * 1024;

export function editableText(text: string): boolean {
  return new TextEncoder().encode(text).length <= EDIT_MAX && !text.startsWith('version https://git-lfs.github.com/spec/v1');
}

export function updateFileBody(text: string, sha: string, branch: string, message: string, description: string, newBranch?: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    content: btoa(binary), sha, branch,
    message: `${message.trim()}${description.trim() ? `\n\n${description.trim()}` : ''}`,
    ...(newBranch ? {new_branch: newBranch.trim()} : {}),
  };
}
