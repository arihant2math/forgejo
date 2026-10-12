// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from 'vitest';
import * as P from '../protocol/types.gen.ts';
import {canHold, clientSchemas, groupId, groupKind, groupName, issueGroup, MODEL_NAMES, MODELS, repoGroup, repoOfGroup} from './models.ts';

test('every protocol model is catalogued with its schema version', () => {
  const protocolModels = Object.entries(P).filter(([k]) => /^Model[A-Z]/.test(k)).map(([, v]) => v as string);
  expect([...MODEL_NAMES].sort()).toEqual([...protocolModels].sort());
  const schemas = clientSchemas();
  for (const m of MODEL_NAMES) expect(schemas[m]).toBe((P as Record<string, unknown>)[`Schema${m}`]);
});

test('group kinds mirror services/livesync/hub/models.go', () => {
  const src = readFileSync(resolve(process.cwd(), '../services/livesync/hub/models.go'), 'utf8');
  const body = src.slice(src.indexOf('var modelKinds'), src.indexOf('\n}\n', src.indexOf('var modelKinds')));
  const prefixes: Record<string, string> = {
    GroupPrefixRepo: 'repo', GroupPrefixOrg: 'org', GroupPrefixUser: 'user', GroupPrefixIssue: 'issue',
    GroupPrefixProfile: 'profile', GroupPrefixProfiles: 'profiles', GroupPrefixOwner: 'owner', GroupPrefixTeam: 'team',
  };
  const go = new Map<string, string[]>();
  for (const m of body.matchAll(/protocol\.Model(\w+):\s*\{([^}]*)\}/g)) {
    const kinds = [...(m[2] ?? '').matchAll(/protocol\.(GroupPrefix\w+)/g)].map((k) => prefixes[k[1] ?? ''] ?? '?');
    go.set(m[1] ?? '', kinds);
  }
  expect([...go.keys()].sort()).toEqual([...MODEL_NAMES].sort());
  for (const m of MODEL_NAMES) expect([...MODELS[m].kinds].sort(), m).toEqual([...(go.get(m) ?? [])].sort());
});

test('group names parse like protocol.ParseGroup', () => {
  expect(groupKind('repo:12')).toBe('repo');
  expect(groupKind('profiles:public')).toBe('profiles');
  expect(groupKind('profiles:other')).toBeUndefined();
  expect(groupKind('repo:012')).toBeUndefined();
  expect(groupKind('repo:0')).toBeUndefined();
  expect(groupKind('*')).toBeUndefined();
  expect(groupKind('!perm')).toBeUndefined();
  expect(groupKind('team:1')).toBe('team');
  expect(groupId('issue:7')).toBe(7);
  expect(groupId('profiles:limited')).toBe(0);
  expect(groupKind('toString:1')).toBeUndefined();
  expect(repoOfGroup('repo:12')).toBe(12);
  expect(repoOfGroup('issue:12')).toBeUndefined();
  expect(canHold('repo', 'Issue')).toBe(true);
  expect(canHold('user', 'Issue')).toBe(false);
});

test('group names are built from the protocol prefixes', () => {
  expect(repoGroup(3)).toBe(`${P.GroupPrefixRepo}:3`);
  expect(issueGroup(4)).toBe(`${P.GroupPrefixIssue}:4`);
  expect(groupName('team', 5)).toBe(`${P.GroupPrefixTeam}:5`);
  for (const kind of ['user', 'org', 'repo', 'issue', 'profile', 'owner', 'team'] as const) expect(groupKind(groupName(kind, 9))).toBe(kind);
});
