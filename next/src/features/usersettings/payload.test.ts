// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {RequestFailed} from '../../app/api.ts';
import {
  applyPatch, diffStyleOf, expired, fieldError, gpgKeyProblem, keepUnsaved, looksLikeEmail, mergeEmails, type Profile, profilePayload, profileProblems, revertPatch,
  scopeRefused, shownProfile, sortEmails, spacedKeyId, sshKeyProblem, sshKeyTitle, toBase64, type UserSettings, validWebsite, withPrimary,
} from './payload.ts';

const profile: Profile = {full_name: 'Ada Lovelace', pronouns: 'she/her', website: 'https://ada.example', location: 'London', description: 'Analyst.'};

const settings: UserSettings = {
  ...profile, language: 'en-US', theme: 'forgejo-auto', diff_view_style: '', enable_repo_unit_hints: true, hide_email: false, hide_pronouns: false,
  hide_activity: false,
};

test('a profile form sends only what it changed, trimmed', () => {
  expect(profilePayload({}, profile)).toBeUndefined();
  // Edited back to the current value (spaces aside): nothing to send.
  expect(profilePayload({full_name: ' Ada Lovelace '}, profile)).toBeUndefined();
  expect(profilePayload({full_name: '  Ada King ', location: 'London'}, profile)).toEqual({full_name: 'Ada King'});
  // Clearing a field is a change (to empty).
  expect(profilePayload({website: '  '}, profile)).toEqual({website: ''});
  expect(profilePayload({description: '\nLine one\n\nLine two\n'}, profile)).toEqual({description: 'Line one\n\nLine two'});
});

test('the form shows the draft over the current values; a save leaves what was typed meanwhile', () => {
  expect(shownProfile({location: 'Paris'}, profile)).toEqual({...profile, location: 'Paris'});
  expect(keepUnsaved({full_name: 'Ada King ', location: 'Paris'}, {full_name: 'Ada King'})).toEqual({location: 'Paris'});
  expect(keepUnsaved({full_name: 'Ada K'}, {full_name: 'Ada King'})).toEqual({full_name: 'Ada K'});
});

test('Forgejo\'s limits and website check, before sending', () => {
  expect(profileProblems(profile)).toEqual({});
  const long = profileProblems({...profile, location: 'x'.repeat(51), full_name: '😀'.repeat(100)});
  expect(long.location).toMatch(/At most 50 characters/);
  // Characters, not UTF-16 units (Forgejo's MaxSize counts runes).
  expect(long.full_name).toBeUndefined();
  expect(profileProblems({...profile, website: 'ada.example'}).website).toMatch(/http/);
  for (const w of ['', 'https://ada.example/x', 'http://localhost:3000']) expect(validWebsite(w), w).toBe(true);
  for (const w of ['ada.example', 'javascript:alert(1)', 'ftp://ada.example', 'https://']) expect(validWebsite(w), w).toBe(false);
});

test('a 422 names its field; other errors belong to the form', () => {
  expect(fieldError(new RequestFailed(422, '[Website]: Website is not a valid URL'))).toEqual({field: 'website', message: 'Website is not a valid URL'});
  expect(fieldError(new RequestFailed(422, '[FullName]: MaxSize'))).toEqual({field: 'full_name', message: 'MaxSize'});
  expect(fieldError(new RequestFailed(422, 'Email address has been used: a@b.c'))).toEqual({field: undefined, message: 'Email address has been used: a@b.c'});
  expect(fieldError(new RequestFailed(500, '[Website]: x')).field).toBeUndefined();
  expect(fieldError(new Error('Forgejo could not be reached.'))).toEqual({field: undefined, message: 'Forgejo could not be reached.'});
  expect(scopeRefused(new RequestFailed(403, 'token does not have at least one of required scope(s): [write:user]'))).toBe(true);
  expect(scopeRefused(new RequestFailed(403, 'Forbidden'))).toBe(false);
});

test('an optimistic patch, and its undo when Forgejo refuses', () => {
  const on = applyPatch(settings, {hide_email: true});
  expect(on.hide_email).toBe(true);
  expect(revertPatch(on, settings, {hide_email: true})).toEqual(settings);
  // A field changed since (a later write) keeps its newer value.
  const later = {...on, hide_email: true, theme: 'forgejo-dark'};
  expect(revertPatch(later, settings, {theme: 'gitea-dark'}).theme).toBe('forgejo-dark');
  expect(diffStyleOf('')).toBe('unified');
  expect(diffStyleOf('split')).toBe('split');
});

test('email addresses: the primary first, merged and switched', () => {
  const list = [
    {email: 'b@x.org', verified: true, primary: false},
    {email: 'a@x.org', verified: false, primary: false},
    {email: 'c@x.org', verified: true, primary: true},
  ];
  expect(sortEmails(list).map((e) => e.email)).toEqual(['c@x.org', 'a@x.org', 'b@x.org']);
  expect(withPrimary(list, 'B@x.org').filter((e) => e.primary).map((e) => e.email)).toEqual(['b@x.org']);
  expect(mergeEmails(list, [{email: 'A@x.org', verified: true, primary: false}]).map((e) => e.email)).toEqual(['b@x.org', 'c@x.org', 'A@x.org']);
  expect(looksLikeEmail(' ada@example.com ')).toBe(true);
  for (const e of ['ada', 'ada@', '@example.com', 'a b@c.d']) expect(looksLikeEmail(e), e).toBe(false);
});

test('SSH and GPG keys as pasted', () => {
  const ed = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs4GE3ZIPkDvJwOLkhw3Ms1CVTX4ALUj9e8pnGhGmXg ada@laptop';
  expect(sshKeyProblem(ed)).toBeUndefined();
  expect(sshKeyProblem('')).toMatch(/Paste/);
  expect(sshKeyProblem('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl')).toMatch(/private key/);
  expect(sshKeyProblem('hello world')).toMatch(/does not look like/);
  expect(sshKeyProblem('---- BEGIN SSH2 PUBLIC KEY ----\nAAAA\n---- END SSH2 PUBLIC KEY ----')).toBeUndefined();
  expect(sshKeyTitle('', ed)).toBe('ada@laptop');
  expect(sshKeyTitle(' Work ', ed)).toBe('Work');
  expect(sshKeyTitle('', 'ssh-rsa AAAAB3NzaC1yc2E=')).toBe('ssh-rsa');
  expect(gpgKeyProblem('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBF…')).toBeUndefined();
  expect(gpgKeyProblem('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toMatch(/private key/);
  expect(gpgKeyProblem('mQINBF')).toMatch(/BEGIN PGP PUBLIC KEY BLOCK/);
  expect(spacedKeyId('3cee76bd8d8ba5e0')).toBe('3CEE 76BD 8D8B A5E0');
  const now = Date.parse('2026-10-11T00:00:00Z');
  expect(expired('0001-01-01T00:00:00Z', now)).toBe(false);
  expect(expired('2026-01-01T00:00:00Z', now)).toBe(true);
  expect(expired('2027-01-01T00:00:00Z', now)).toBe(false);
});

test('a picture\'s bytes as base64', () => {
  expect(toBase64(new Uint8Array([137, 80, 78, 71]))).toBe('iVBORw==');
  const big = new Uint8Array(100_000).fill(255);
  expect(atob(toBase64(big)).length).toBe(100_000);
});
