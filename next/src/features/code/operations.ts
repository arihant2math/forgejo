// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export interface FileOperation {operation: 'create' | 'delete'; path: string; content?: string; sha?: string}
export function filePathProblem(path: string): string | undefined {
  if (!path || path.length > 500 || path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || path.includes('\\') || path.split('').some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return 'Enter a relative file path without empty, dot, or .git segments (maximum 500 characters).';
  return undefined;
}
