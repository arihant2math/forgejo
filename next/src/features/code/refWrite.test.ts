// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import type {RefTable} from '../../code/refs.ts';
import {
  assetUploadPath, branchDeleteBlock, createBranchBody, createReleaseBody, createTagBody, draftsOf, editReleaseBody, looksLikeSha, refNameProblem,
  refSpec, releaseTagProblem, tagDeleteBlock, writeBlock,
} from './refWrite.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const refs: RefTable = {
  branches: new Map([['main', A], ['feature', B], ['release/1.x', A], ['v2', B]]),
  tags: new Map([['v1.0', A], ['v2', A]]),
  defaultBranch: 'main',
};

describe('ref names (git check-ref-format, as Forgejo checks them)', () => {
  test('good names', () => {
    for (const n of ['fix-login', 'feature2/x', 'release/2.x', 'user@host', 'a.b', 'ünïcode']) expect(refNameProblem(n, 'branch', refs), n).toBeUndefined();
    for (const n of ['v1.1', 'v1.0.1-rc.1']) expect(refNameProblem(n, 'tag', refs), n).toBeUndefined();
  });

  test('what git refuses', () => {
    for (const n of [
      '', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a\tb', '/a', 'a/', 'a//b', '.a', 'a/.b', 'a..b', 'a.', 'a.lock', 'a.lock/b',
      'a@{1}', '@', '-a', 'HEAD', 'x'.repeat(101),
    ]) {
      expect(refNameProblem(n, 'branch', refs), JSON.stringify(n)).toBeDefined();
    }
    // HEAD is a branch-only rule; a tag may be longer than a branch.
    expect(refNameProblem('HEAD', 'tag', refs)).toBeUndefined();
    expect(refNameProblem('x'.repeat(101), 'tag', refs)).toBeUndefined();
    expect(refNameProblem('x'.repeat(256), 'tag', refs)).toBeDefined();
  });

  test('names taken: the same name, or a folder clash', () => {
    expect(refNameProblem('feature', 'branch', refs)).toMatch(/exists already/);
    expect(refNameProblem('feature/x', 'branch', refs)).toMatch(/clashes with the branch “feature”/);
    expect(refNameProblem('release', 'branch', refs)).toMatch(/clashes with the branch “release\/1.x”/);
    // A tag and a branch may share a name (git keeps them apart).
    expect(refNameProblem('feature', 'tag', refs)).toBeUndefined();
    expect(refNameProblem('v1.0', 'tag', refs)).toMatch(/exists already/);
  });
});

test('a choice as API v1 resolves it: the name, its commit when a branch and a tag share it', () => {
  expect(refSpec({kind: 'branch', ref: 'feature'}, refs)).toBe('feature');
  expect(refSpec({kind: 'tag', ref: 'v1.0'}, refs)).toBe('v1.0');
  expect(refSpec({kind: 'branch', ref: 'v2'}, refs)).toBe(B);
  expect(refSpec({kind: 'tag', ref: 'v2'}, refs)).toBe(A);
  expect(refSpec({kind: 'commit', ref: 'abc1234'}, refs)).toBe('abc1234');
  expect(looksLikeSha('abc1234')).toBe(true);
  expect(looksLikeSha(A)).toBe(true);
  expect(looksLikeSha('abc12')).toBe(false);
  expect(looksLikeSha('main')).toBe(false);
});

test('branch and tag payloads', () => {
  expect(createBranchBody('fix', {kind: 'branch', ref: 'main'}, refs)).toEqual({new_branch_name: 'fix', old_ref_name: 'main'});
  expect(createBranchBody('fix', {kind: 'commit', ref: B}, refs)).toEqual({new_branch_name: 'fix', old_ref_name: B});
  // A message makes an annotated tag; whitespace alone is none.
  expect(createTagBody('v3', {kind: 'branch', ref: 'main'}, '  The third.\n', refs)).toEqual({tag_name: 'v3', target: 'main', message: 'The third.'});
  expect(createTagBody('v3', {kind: 'tag', ref: 'v1.0'}, '  ', refs)).toEqual({tag_name: 'v3', target: 'v1.0', message: ''});
});

test('why a write is not offered', () => {
  const ok = {archived: false, mirror: false};
  expect(writeBlock(ok, true, 'Creating a branch', true)).toBeUndefined();
  expect(writeBlock({archived: true, mirror: false}, true, 'Creating a branch', true)).toMatch(/archived/);
  expect(writeBlock({archived: false, mirror: true}, true, 'Creating a branch', true)).toMatch(/mirror/);
  // A mirror's releases are its own.
  expect(writeBlock({archived: false, mirror: true}, true, 'Saving a release', false)).toBeUndefined();
  expect(writeBlock(ok, false, 'Creating a branch', true)).toBe('Creating a branch needs a connection: it is not queued offline.');
  expect(branchDeleteBlock('main', 'main', false)).toMatch(/default branch/);
  expect(branchDeleteBlock('feature', 'main', true)).toMatch(/protected/);
  expect(branchDeleteBlock('feature', 'main', undefined)).toBeUndefined();
  expect(tagDeleteBlock(true)).toMatch(/release/);
  expect(tagDeleteBlock(false)).toBeUndefined();
});

describe('releases', () => {
  const known = [{id: 1, tag_name: 'v1.0', is_tag: false}, {id: 2, tag_name: 'v2', is_tag: true}];

  test('a release\'s tag: existing (without a release), or a new valid name', () => {
    expect(releaseTagProblem('', refs, known)).toMatch(/needs a tag/);
    expect(releaseTagProblem('v1.0', refs, known)).toMatch(/has a release already/);
    expect(releaseTagProblem('v1.0', refs, known, 1)).toBeUndefined();
    expect(releaseTagProblem('v2', refs, known)).toBeUndefined();
    expect(releaseTagProblem('v3', refs, known)).toBeUndefined();
    expect(releaseTagProblem('v 3', refs, known)).toBeDefined();
  });

  const fields = {tag: ' v3 ', target: 'main', title: '  ', notes: 'Notes', prerelease: true};

  test('a new release: the title defaults to the tag', () => {
    expect(createReleaseBody(fields, true)).toEqual({tag_name: 'v3', target_commitish: 'main', name: 'v3', body: 'Notes', draft: true, prerelease: true});
    expect(createReleaseBody({...fields, title: ' Third '}, false).name).toBe('Third');
  });

  test('an edit: a draft\'s tag may change, a published one\'s not; cleared notes are cleared', () => {
    expect(editReleaseBody(fields, {notes: 'Old', draft: true}, false)).toEqual({tag_name: 'v3', target_commitish: 'main', name: 'v3', body: 'Notes', draft: false, prerelease: true});
    expect(editReleaseBody(fields, {notes: 'Old', draft: false}, false)).toEqual({name: 'v3', body: 'Notes', draft: false, prerelease: true});
    expect(editReleaseBody({...fields, notes: ''}, {notes: 'Old', draft: false}, true).body).toBe(' ');
    expect(editReleaseBody({...fields, notes: ''}, {notes: '', draft: false}, true).body).toBe('');
  });

  test('drafts from API v1: drafts only, newest first, assets kept', () => {
    const list = draftsOf([
      {id: 1, tag_name: 'v1', draft: true, created_at: '2026-01-01T00:00:00Z', assets: [{id: 9, name: 'a.zip', size: 3, uuid: 'u', browser_download_url: 'https://x/a.zip'}]},
      {id: 2, tag_name: 'v2', draft: false, created_at: '2026-02-01T00:00:00Z'},
      {id: 3, tag_name: 'v3', draft: true, created_at: '2026-03-01T00:00:00Z', assets: null, prerelease: true},
      {tag_name: 'nope', draft: true},
    ]);
    expect(list.map((d) => d.id)).toEqual([3, 1]);
    expect(list[0]).toMatchObject({tag_name: 'v3', prerelease: true, assets: [], body: '', name: ''});
    expect(list[1]?.assets).toEqual([{id: 9, name: 'a.zip', size: 3, uuid: 'u', url: 'https://x/a.zip'}]);
  });

  test('an asset\'s upload address names the file', () => {
    expect(assetUploadPath('/repos/acme/atlas', 7, 'my build.tar.gz')).toBe('/repos/acme/atlas/releases/7/assets?name=my+build.tar.gz');
  });
});
