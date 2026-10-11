// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

export function uploadPlaceholder(id: string, name: string): string {
  return `<!-- uploading-attachment:${id} ${name.replaceAll('--', '—').replaceAll(/[\r\n<>]/g, '')}… -->`;
}

export function stripUploadPlaceholders(text: string): string {
  return text.replaceAll(/<!-- uploading-attachment:[\s\S]*? -->/g, '');
}

export function hasPendingUploads(text: string): boolean {
  return text.includes('<!-- uploading-attachment:');
}

/** Missing/edited placeholders are not resurrected when an upload finishes. */
export function replaceUpload(text: string, placeholder: string, replacement: string): string {
  return text.replace(placeholder, () => replacement);
}

export function attachmentMarkdown(file: Pick<File, 'name' | 'type'>, url: string): string {
  const name = file.name.replaceAll(/[\\[\]]/g, '\\$&').replaceAll(/[\r\n]/g, ' ');
  const safeURL = url.replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29');
  const image = file.type.startsWith('image/') || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name);
  return `${image ? '!' : ''}[${name}](${safeURL})`;
}
