// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Emoji shortcodes (`:cherry_blossom:`) in plain text, as Forgejo renders them
// in descriptions (modules/markup emojiShortCodeProcessor). emoji.json is a copy
// of Forgejo's assets/emoji.json (gemoji: [emoji, [aliases]]), kept equal to it
// by emoji.test.ts; next/ is its own Vite workspace and cannot import from
// outside it. The text is returned as text, never HTML: React escapes it.

import data from './emoji.json' with {type: 'json'};

/** [emoji, its aliases] (the JSON module's inferred type is an array of string | string[]). */
const table = data as [string, string[]][];

let byAlias: Map<string, string> | undefined;

/** The emoji for a gemoji alias (without the colons), or undefined. */
export function emojiOf(alias: string): string | undefined {
  byAlias ??= new Map(table.flatMap(([emoji, aliases]) => aliases.map((a) => [a, emoji] as [string, string])));
  return byAlias.get(alias);
}

const SHORTCODE = /:([-+\w]+):/g;

/**
 * s with every known `:alias:` replaced by its emoji. Unknown names and other
 * colon-delimited text stay as they are; an unknown name's closing colon may
 * open the next shortcode (`x:foo_bar:smile:` → `x:foo_bar😄`).
 */
export function emojify(s: string): string {
  if (!s.includes(':')) return s;
  let out = '';
  let last = 0;
  SHORTCODE.lastIndex = 0;
  for (let m = SHORTCODE.exec(s); m; m = SHORTCODE.exec(s)) {
    const emoji = emojiOf(m[1] ?? '');
    if (emoji === undefined) {
      SHORTCODE.lastIndex = m.index + m[0].length - 1;
      continue;
    }
    out += s.slice(last, m.index) + emoji;
    last = m.index + m[0].length;
  }
  return last === 0 ? s : out + s.slice(last);
}
