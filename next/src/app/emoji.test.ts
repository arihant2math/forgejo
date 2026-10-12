// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';
import {emojiOf, emojify} from './emoji.ts';
import table from './emoji.json' with {type: 'json'};

test('the table is Forgejo\'s assets/emoji.json', () => {
  const upstream: unknown = JSON.parse(readFileSync(new URL('../../../assets/emoji.json', import.meta.url), 'utf8'));
  expect(table).toEqual(upstream);
});

test('known shortcodes become their emoji (#269)', () => {
  expect(emojiOf('cherry_blossom')).toBe('🌸');
  expect(emojiOf('+1')).toBe('👍');
  expect(emojiOf('thumbsup')).toBe('👍');
  expect(emojify(':cherry_blossom: A command-line fuzzy finder — QA mirror of junegunn/fzf'))
    .toBe('🌸 A command-line fuzzy finder — QA mirror of junegunn/fzf');
  expect(emojify('Fast :rocket: and :+1: safe :lock:')).toBe('Fast 🚀 and 👍 safe 🔒');
  expect(emojify(':smile::tada:')).toBe('😄🎉');
});

test('unknown names and other colon text stay as they are', () => {
  expect(emojify('no colons')).toBe('no colons');
  expect(emojify(':not_an_emoji: here')).toBe(':not_an_emoji: here');
  expect(emojify('at 10:30:45, key: value')).toBe('at 10:30:45, key: value');
  expect(emojify('see http://example.com:8080/')).toBe('see http://example.com:8080/');
  expect(emojify(':Smile:')).toBe(':Smile:');
  // As the server's emojiShortCodeProcessor: the scan resumes after an unknown name, whose closing colon is spent.
  expect(emojify(':unknown:smile:')).toBe(':unknown:smile:');
  expect(emojify(':unknown: :smile:')).toBe(':unknown: 😄');
});

test('Unicode emoji stay; HTML-like text stays text', () => {
  expect(emojify('🌸 already :tada:')).toBe('🌸 already 🎉');
  expect(emojify('<img src=x onerror=alert(1)> :tada: <b>bold</b>')).toBe('<img src=x onerror=alert(1)> 🎉 <b>bold</b>');
  expect(emojify(':<script>:')).toBe(':<script>:');
});
