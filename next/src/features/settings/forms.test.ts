// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {repo, user} from '../../test/fakeSession.ts';
import {
  defaultStyleChoices, detailsOf, detailsPatch, FEATURES, featureState, mergeStyleToggle, newOwnerOf, pullSettingsOf, sameDetails, validateDetails,
} from './forms.ts';
import {problemOf} from './problems.ts';
import {RequestFailed} from '../../app/api.ts';

const r = repo(1, user(2, 'acme'), 'atlas', {description: 'Maps', website: 'https://atlas.example', template: false});

describe('name, description, website', () => {
  test('only the fields that changed are sent, trimmed', () => {
    const base = detailsOf(r);
    expect(detailsPatch(base, base)).toEqual({});
    expect(detailsPatch(base, {...base, description: '  Maps  '})).toEqual({});
    expect(detailsPatch(base, {...base, name: ' atlas2 ', website: ''})).toEqual({name: 'atlas2', website: ''});
    expect(sameDetails(base, {...base})).toBe(true);
  });

  test('checked before sending, as Forgejo checks', () => {
    const base = detailsOf(r);
    expect(validateDetails(base)).toEqual({});
    expect(validateDetails({...base, name: ''}).name).toMatch(/needs a name/);
    expect(validateDetails({...base, name: 'a b'}).name).toMatch(/only letters/);
    expect(validateDetails({...base, name: 'x'.repeat(101)}).name).toMatch(/100/);
    expect(validateDetails({...base, name: '..'}).name).toMatch(/not allowed/);
    expect(validateDetails({...base, name: 'a..b'}).name).toMatch(/not allowed/);
    expect(validateDetails({...base, name: 'atlas.git'}).name).toMatch(/\.git/);
    expect(validateDetails({...base, name: 'my-repo_1.0'})).toEqual({});
    expect(validateDetails({...base, website: 'atlas.example'}).website).toMatch(/http/);
    expect(validateDetails({...base, website: 'javascript:alert(1)'}).website).toMatch(/http/);
    expect(validateDetails({...base, website: ''})).toEqual({});
    expect(validateDetails({...base, description: 'x'.repeat(2049)}).description).toMatch(/2048/);
  });
});

describe('features', () => {
  test('a feature is on with its unit or its external variant', () => {
    const issues = FEATURES.find((f) => f.key === 'has_issues');
    const wiki = FEATURES.find((f) => f.key === 'has_wiki');
    if (!issues || !wiki) throw new Error('missing features');
    expect(featureState(new Set(['issues']), issues)).toEqual({on: true, external: false});
    expect(featureState(new Set(['ext_issues']), issues)).toEqual({on: true, external: true});
    expect(featureState(new Set(['code']), issues)).toEqual({on: false, external: false});
    expect(featureState(new Set(['ext_wiki']), wiki)).toEqual({on: true, external: true});
  });
});

describe('merge styles', () => {
  const config = {
    AllowMerge: true, AllowRebase: false, AllowRebaseMerge: false, AllowSquash: true, AllowFastForwardOnly: false, AllowManualMerge: false,
    DefaultMergeStyle: 'squash', DefaultDeleteBranchAfterMerge: true, AllowRebaseUpdate: false, DefaultAllowMaintainerEdit: true,
  };

  test('read from the pull requests unit (Forgejo’s defaults for what is missing)', () => {
    const s = pullSettingsOf(config);
    expect(s.allowed).toEqual({'merge': true, 'rebase': false, 'rebase-merge': false, 'squash': true, 'fast-forward-only': false, 'manually-merged': false});
    expect(s).toMatchObject({defaultStyle: 'squash', deleteBranch: true, rebaseUpdate: false, maintainerEdit: true});
    const d = pullSettingsOf({DefaultMergeStyle: 'octopus'});
    expect(d.defaultStyle).toBe('merge');
    expect(Object.values(d.allowed).every(Boolean)).toBe(true);
    expect(d.rebaseUpdate).toBe(true);
  });

  test('toggling: the field; disallowing the default moves it; the last way of merging stays', () => {
    const s = pullSettingsOf(config);
    expect(mergeStyleToggle(s, 'rebase', true)).toEqual({patch: {allow_rebase: true}});
    expect(mergeStyleToggle(s, 'merge', false)).toEqual({patch: {allow_merge_commits: false}});
    expect(mergeStyleToggle(s, 'squash', false)).toEqual({patch: {allow_squash_merge: false, default_merge_style: 'merge'}});
    const one = {...s, allowed: {...s.allowed, merge: false}};
    expect(mergeStyleToggle(one, 'squash', false)).toEqual({error: 'At least one way of merging must stay allowed.'});
    // Marking merged by hand is no way of merging: it can always go.
    const manual = {...one, allowed: {...one.allowed, 'manually-merged': true}};
    expect(mergeStyleToggle(manual, 'manually-merged', false)).toEqual({patch: {allow_manual_merge: false}});
  });

  test('the default is one of the allowed styles (or the current one)', () => {
    const s = pullSettingsOf(config);
    expect(defaultStyleChoices(s).map((m) => m.style)).toEqual(['merge', 'squash']);
    expect(defaultStyleChoices({...s, defaultStyle: 'rebase'}).map((m) => m.style)).toEqual(['merge', 'rebase', 'squash']);
  });
});

test('a transfer’s new owner', () => {
  expect(newOwnerOf(' @bob ', 'acme')).toEqual({owner: 'bob'});
  expect(newOwnerOf('', 'acme')).toHaveProperty('error');
  expect(newOwnerOf('ACME', 'acme')).toEqual({error: 'The repository already belongs to them.'});
  expect(newOwnerOf('a/b', 'acme')).toHaveProperty('error');
});

describe('the server’s refusals', () => {
  const fields = {name: 'name', 'repo name': 'name', website: 'website', url: 'url', 'content type': 'contentType', branchfilter: 'branchFilter'};

  test('binding failures name the field', () => {
    expect(problemOf(new RequestFailed(422, '[Name]: AlphaDashDot'), fields)).toEqual({field: 'name', message: 'Use only letters, digits, “-”, “_” and “.”.'});
    expect(problemOf(new RequestFailed(422, '[BranchFilter]: GlobPattern'), fields)).toEqual({field: 'branchFilter', message: 'Not a valid glob pattern.'});
    expect(problemOf(new RequestFailed(422, '[Title]: Required'), {})).toEqual({message: 'Required.'});
  });

  test('Forgejo’s sentences: reworded, next to the field they name', () => {
    expect(problemOf(new RequestFailed(422, 'repo name is already taken [name: atlas]'), fields)).toEqual({field: 'name', message: 'A repository with this name already exists here.'});
    expect(problemOf(new RequestFailed(422, 'Invalid url'), fields)).toEqual({field: 'url', message: 'Not a valid URL.'});
    expect(problemOf(new RequestFailed(422, 'Invalid content type'), fields)).toEqual({field: 'contentType', message: 'Not a content type Forgejo knows.'});
    expect(problemOf(new RequestFailed(422, 'Missing config option: url'), fields).field).toBe('url');
  });

  test('anything else is said as it is', () => {
    expect(problemOf(new RequestFailed(0, 'Forgejo could not be reached.'))).toEqual({message: 'Forgejo could not be reached.'});
    expect(problemOf(new RequestFailed(404, 'Forgejo answered 404.'))).toEqual({message: 'Not found: it may have been deleted or renamed meanwhile.'});
    expect(problemOf(new RequestFailed(403, 'token does not have at least one of required scope(s)'))).toEqual({message: 'token does not have at least one of required scope(s)'});
    expect(problemOf(new RequestFailed(500, ''))).toEqual({message: 'Forgejo refused the change.'});
  });
});
