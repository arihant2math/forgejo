// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {replaceSuggestions, suggestionOf, suggestionOnly} from './suggestions.ts';

describe('suggested changes', () => {
  it('anchors a selected range at its final line', () => {
    expect(suggestionOf('```suggestion -2+0\na\nb\n```', 8)).toEqual({start: 6, end: 8, text: 'a\nb'});
  });
  it('replaces the text only of a comment that is just a new-side suggestion', () => {
    expect(suggestionOnly('```suggestion\nx\n```\n', 3)).toBe(true);
    expect(suggestionOnly('Try this:\n```suggestion\nx\n```', 3)).toBe(false);
    // Old-side comments carry a negative line and get no suggestion card.
    expect(suggestionOnly('```suggestion\nx\n```', -3)).toBe(false);
  });
  it('applies a batch bottom-up without moving later anchors', () => {
    expect(replaceSuggestions('a\nb\nc\n', [{start: 1, end: 1, text: 'x\ny', original: 'a'}, {start: 3, end: 3, text: 'z', original: 'c'}])).toBe('x\ny\nb\nz\n');
  });
  it('refuses changed lines and overlapping ranges', () => {
    expect(() => replaceSuggestions('a', [{start: 1, end: 1, text: 'b', original: 'old'}])).toThrow('stale');
    expect(() => replaceSuggestions('a', [{start: 1, end: 1, text: 'b', original: 'a'}, {start: 1, end: 1, text: 'c', original: 'a'}])).toThrow('overlaps');
  });
});
