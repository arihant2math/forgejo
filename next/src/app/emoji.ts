// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Match Forgejo's shortcode rendering; return plain text so React escapes it.
// The emoji table is copied because this Vite workspace cannot import outside itself.

import data from './emoji.json' with {type: 'json'};

const table = data as [string, string[]][];

let byAlias: Map<string, string> | undefined;

/** The emoji for a gemoji alias (without the colons), or undefined. */
export function emojiOf(alias: string): string | undefined {
  byAlias ??= new Map(table.flatMap(([emoji, aliases]) => aliases.map((a) => [a, emoji] as [string, string])));
  return byAlias.get(alias);
}

const SHORTCODE = /:([-+\w]+):/g;

/** Replaces known, case-sensitive aliases; unknown names consume their closing colon, matching Forgejo. */
export function emojify(s: string): string {
  if (!s.includes(':')) return s;
  return s.replace(SHORTCODE, (code, alias: string) => emojiOf(alias) ?? code);
}
