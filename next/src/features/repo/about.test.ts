// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import type {Release} from '../../protocol/types.gen.ts';
import {percent} from '../../ui/index.ts';
import {languageShares, licenseOf, plural, releaseSummary, tagCount} from './about.ts';

function release(id: number, tag: string, created: string, extra: Partial<Release> = {}): Release {
  return {
    id, repo_id: 1, publisher_id: 1, tag_name: tag, target_commitish: 'main', name: '', sha: String(id).padStart(40, '0'), body: '', body_html: '',
    draft: false, prerelease: false, is_tag: false, num_commits: 0, hide_archive_links: false, original_author: '', created_at: created, ...extra,
  };
}

describe('languageShares', () => {
  test('largest first, each in its series slot in order', () => {
    expect(languageShares({TypeScript: 300, Go: 900, CSS: 50})).toEqual([
      {label: 'Go', value: 900, tone: 1}, {label: 'TypeScript', value: 300, tone: 2}, {label: 'CSS', value: 50, tone: 3},
    ]);
  });

  test('past five slots the rest folds into Other, with Forgejo\'s own "other"', () => {
    const s = languageShares({A: 70, B: 60, C: 50, D: 40, E: 30, F: 20, G: 10, other: 5});
    expect(s.map((x) => [x.label, x.tone])).toEqual([['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5], ['Other', 'other']]);
    expect(s.at(-1)?.value).toBe(35);
  });

  test('exactly one past the slots keeps its own name (neutral), rather than "Other"', () => {
    expect(languageShares({A: 6, B: 5, C: 4, D: 3, E: 2, F: 1}).at(-1)).toEqual({label: 'F', value: 1, tone: 'other'});
  });

  test('ignores what is not a positive byte count; nothing for an answer of the wrong shape', () => {
    expect(languageShares({Go: 0, Rust: -1, C: Number.NaN, Zig: '12', Odin: 3})).toEqual([{label: 'Odin', value: 3, tone: 1}]);
    expect(languageShares(null)).toEqual([]);
    expect(languageShares([1, 2])).toEqual([]);
    expect(languageShares({})).toEqual([]);
  });
});

test('percent: one decimal, a sliver is "<0.1%"', () => {
  expect(percent(1, 3)).toBe('33.3%');
  expect(percent(1, 10_000)).toBe('<0.1%');
  expect(percent(0, 0)).toBe('0%');
});

test('licenseOf: LICENSE first, then other spellings; only files', () => {
  const e = (name: string, type = 'blob') => ({name, type});
  expect(licenseOf([e('COPYING'), e('LICENSE.md')])?.name).toBe('LICENSE.md');
  expect(licenseOf([e('README.md'), e('LICENCE-MIT')])?.name).toBe('LICENCE-MIT');
  expect(licenseOf([e('copying.txt')])?.name).toBe('copying.txt');
  expect(licenseOf([e('UNLICENSE')])?.name).toBe('UNLICENSE');
  expect(licenseOf([e('LICENSE', 'tree'), e('licenses.go'), e('README')])).toBeUndefined();
});

describe('releases', () => {
  const all = [
    release(1, 'v1.0.0', '2026-01-01T00:00:00Z'),
    release(2, 'v1.1.0', '2026-03-01T00:00:00Z'),
    release(3, 'v2.0.0-rc1', '2026-05-01T00:00:00Z', {prerelease: true}),
    release(4, 'v2.0.0', '2026-06-01T00:00:00Z', {draft: true, sha: ''}),
    release(5, 'v0.9', '2025-12-01T00:00:00Z', {is_tag: true}),
  ];

  test('the count leaves out drafts and bare tags; Latest is the newest that is not a pre-release', () => {
    const s = releaseSummary(all);
    expect(s.count).toBe(3);
    expect(s.latest?.tag_name).toBe('v1.1.0');
  });

  test('only pre-releases: the newest of them', () => {
    expect(releaseSummary(all.slice(2, 3)).latest?.tag_name).toBe('v2.0.0-rc1');
    expect(releaseSummary([]).latest).toBeUndefined();
  });

  test('tags: every published release and bare tag that names a commit', () => {
    expect(tagCount(all)).toBe(4);
  });
});

test('plural', () => {
  expect(`1 ${plural(1, 'star')}`).toBe('1 star');
  expect(`2 ${plural(2, 'star')}`).toBe('2 stars');
  expect(plural(3, 'watching', 'watching')).toBe('watching');
});
