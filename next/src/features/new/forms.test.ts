// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {RequestFailed} from '../../app/api.ts';
import {fallbackConfig} from '../../app/config.ts';
import {createApp} from '../../app/store.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {
  creationScope, initializes, newOrgRequest, scopeAllows, newRepoRequest, type NewRepoInput, orgNameProblem, orgRefusal, repoNameProblem, repoRefusal, suggestName, templateProblem,
} from './forms.ts';
import {loginTaken, repoOwners, repoTaken, startsPrivate, templateRepos} from './owners.ts';
import {openWhenSynced} from './parts.tsx';
import {parseTemplates} from './templates.ts';

describe('names', () => {
  test('repository names: AlphaDashDot, at most 100, not reserved', () => {
    for (const ok of ['atlas', 'web.site', 'a_b-c', 'A', '1', '.github', 'x.gitx']) expect(repoNameProblem(ok), ok).toBeUndefined();
    expect(repoNameProblem('')).toMatch(/needs a name/);
    expect(repoNameProblem('my project')).toMatch(/only letters/);
    expect(repoNameProblem('café')).toMatch(/only letters/);
    expect(repoNameProblem('a/b')).toMatch(/only letters/);
    expect(repoNameProblem('x'.repeat(101))).toMatch(/100/);
    expect(repoNameProblem('x'.repeat(100))).toBeUndefined();
    for (const r of ['.', '..', '-']) expect(repoNameProblem(r), r).toMatch(/reserved/);
    for (const p of ['atlas.git', 'Atlas.WIKI', 'feed.rss', 'feed.atom']) expect(repoNameProblem(p), p).toMatch(/cannot end in/);
  });

  test('organization names: a user name (dots allowed), not reserved', () => {
    for (const ok of ['acme', 'acme-corp', 'acme.corp', 'a1', '9lives', 'a_b']) expect(orgNameProblem(ok), ok).toBeUndefined();
    expect(orgNameProblem('')).toMatch(/needs a name/);
    expect(orgNameProblem('-acme')).toMatch(/Start with/);
    expect(orgNameProblem('_acme')).toMatch(/Start with/);
    expect(orgNameProblem('acme-')).toMatch(/End with/);
    expect(orgNameProblem('ac--me')).toMatch(/in a row/);
    expect(orgNameProblem('ac._me')).toMatch(/in a row/);
    expect(orgNameProblem('a c')).toMatch(/only letters/);
    expect(orgNameProblem('x'.repeat(41))).toMatch(/40/);
    for (const r of ['repo', 'org', 'Admin', 'explore', 'api', 'ghost']) expect(orgNameProblem(r), r).toMatch(/reserved/);
    for (const p of ['acme.keys', 'acme.png', 'acme.rss']) expect(orgNameProblem(p), p).toMatch(/cannot end in/);
  });

  test('a suggestion for a name Forgejo would refuse', () => {
    expect(suggestName('My cool project!')).toBe('My-cool-project');
    expect(suggestName('  café au lait ')).toBe('caf-au-lait');
    expect(repoNameProblem(suggestName('a b'))).toBeUndefined();
  });
});

const base: NewRepoInput = {
  owner: {login: 'dev', org: false}, name: ' atlas ', description: ' A map. ', private: false, readme: false, gitignores: [], license: '',
  labels: '', defaultBranch: '', objectFormat: '', isTemplate: false,
};

describe('requests', () => {
  test('a personal, empty repository: POST /user/repos without initialization', () => {
    expect(newRepoRequest(base)).toEqual({path: '/user/repos', body: {name: 'atlas', description: 'A map.', private: false, template: false, auto_init: false}});
  });

  test('an organization\'s, initialized: README, .gitignore templates joined, license, labels, branch, object format', () => {
    const r = newRepoRequest({
      ...base, owner: {login: 'acme corp', org: true}, private: true, readme: true, gitignores: ['Go', 'Node'], license: 'MIT', labels: 'Default',
      defaultBranch: 'trunk', objectFormat: 'sha256', isTemplate: true,
    });
    expect(r.path).toBe('/orgs/acme%20corp/repos');
    expect(r.body).toEqual({
      name: 'atlas', description: 'A map.', private: true, template: true, auto_init: true, readme: 'Default', gitignores: 'Go,Node', license: 'MIT',
      issue_labels: 'Default', default_branch: 'trunk', object_format_name: 'sha256',
    });
  });

  test('a .gitignore or a license initializes (Forgejo writes the README with them)', () => {
    expect(initializes({readme: false, gitignores: [], license: ''})).toBe(false);
    expect(initializes({readme: false, gitignores: ['Go'], license: ''})).toBe(true);
    expect(initializes({readme: false, gitignores: [], license: 'MIT'})).toBe(true);
    expect(newRepoRequest({...base, license: 'MIT'}).body).toMatchObject({auto_init: true, readme: 'Default', license: 'MIT', gitignores: ''});
  });

  test('from a template: POST /repos/{template}/generate with the owner and what it passes on (no init options)', () => {
    const items = {git_content: true, topics: false, labels: true, webhooks: false, git_hooks: false, avatar: false, protected_branch: false};
    const r = newRepoRequest({...base, owner: {login: 'acme', org: true}, private: true, readme: true, license: 'MIT', template: {owner: 'tpl', name: 'go-service', items}});
    expect(r.path).toBe('/repos/tpl/go-service/generate');
    expect(r.body).toEqual({owner: 'acme', name: 'atlas', description: 'A map.', private: true, ...items});
    expect(templateProblem(items)).toBeUndefined();
    expect(templateProblem({...items, git_content: false, labels: false})).toMatch(/at least one/);
  });

  test('a new organization: POST /orgs', () => {
    expect(newOrgRequest({name: ' acme ', visibility: 'limited', repoAdminChangeTeamAccess: true}))
      .toEqual({path: '/orgs', body: {username: 'acme', visibility: 'limited', repo_admin_change_team_access: true}});
  });
});

test('the scope a creation needs, and whether the UI\'s sign-in has it', () => {
  expect(creationScope(false)).toBe('write:user');
  expect(creationScope(true)).toBe('write:organization');
  // A sign-in without them (an instance that has not upgraded yet), and the UI's own (oauthapp.Scope).
  const old = 'write:issue write:repository read:user read:organization write:notification';
  expect(scopeAllows(old, 'write:user')).toBe(false);
  expect(scopeAllows(old, 'write:organization')).toBe(false);
  const ui = 'write:issue write:repository write:user write:organization write:notification';
  expect(scopeAllows(ui, 'write:user')).toBe(true);
  expect(scopeAllows(ui, 'write:organization')).toBe(true);
  expect(scopeAllows(`${old} write:user`, 'write:user')).toBe(true);
  expect(scopeAllows('all', 'write:organization')).toBe(true);
  expect(scopeAllows('write:user,write:organization', 'write:organization')).toBe(true);
  expect(scopeAllows(undefined, 'write:user')).toBe(true);
  expect(repoRefusal(new RequestFailed(403, 'token does not have at least one of required scope(s): [write:user]')).text).toMatch(/classic form/);
  expect(orgRefusal(new RequestFailed(403, 'token does not have at least one of required scope(s): [write:organization]')).text).toMatch(/classic form/);
});

describe('refusals', () => {
  test('a repository: the name, the limit, the quota, the organization', () => {
    expect(repoRefusal(new RequestFailed(409, 'The repository with the same name already exists.'))).toEqual({field: 'name', text: 'A repository with this name already exists.'});
    expect(repoRefusal(new RequestFailed(422, 'name is reserved [name: -]'))).toEqual({field: 'name', text: '“-” is reserved.'});
    expect(repoRefusal(new RequestFailed(422, 'name pattern is not allowed [pattern: *.git]'))).toEqual({field: 'name', text: 'Names like “*.git” are not allowed.'});
    // A site administrator (or a dev build) is told the limit; everyone else gets an empty 500.
    expect(repoRefusal(new RequestFailed(500, 'user has reached maximum limit of repositories [limit: 3]')).text).toBe('You have reached the number of repositories you may create (3).');
    expect(repoRefusal(new RequestFailed(500, 'user has reached maximum limit of repositories [limit: -1]')).text).toBe('You have reached the number of repositories you may create.');
    expect(repoRefusal(new RequestFailed(500, 'Forgejo answered 500.'))).toMatchObject({field: 'form', text: expect.stringMatching(/number of repositories/) as unknown});
    expect(repoRefusal(new RequestFailed(413, 'quota exceeded')).text).toMatch(/quota/);
    expect(repoRefusal(new RequestFailed(403, 'Given user is not allowed to create repository in organization.')).text).toBe('Given user is not allowed to create repository in organization.');
    expect(repoRefusal(new RequestFailed(0, 'Forgejo could not be reached.'))).toEqual({field: 'form', text: 'Forgejo could not be reached.'});
  });

  test('an organization: the name, not allowed', () => {
    expect(orgRefusal(new RequestFailed(422, 'user already exists [name: acme]'))).toEqual({field: 'name', text: 'This name is taken by a user or an organization.'});
    expect(orgRefusal(new RequestFailed(422, 'name is reserved [name: repo]'))).toEqual({field: 'name', text: '“repo” is reserved.'});
    expect(orgRefusal(new RequestFailed(403, 'Create organization not allowed'))).toEqual({field: 'form', text: 'Your account may not create organizations.'});
  });
});

describe('the pool', () => {
  function setup() {
    const s = fakeSession({userId: 1});
    const d = s.data;
    const dev = user(1, 'dev');
    d.put('User', 'profiles:public', dev);
    for (const [id, login] of [[10, 'acme'], [11, 'zeta'], [12, 'readers'], [13, 'beta']] as const) d.put('User', `org:${String(id)}`, user(id, login, 'organization'));
    const team = (id: number, org: number, permission: string, canCreate: boolean) => ({
      id, org_id: org, name: `t${String(id)}`, description: '', permission, includes_all_repositories: false, can_create_org_repo: canCreate, num_members: 1, num_repos: 0,
    });
    d.put('Team', 'org:10', team(100, 10, 'owner', false));
    d.put('Team', 'org:11', team(110, 11, 'write', true));
    d.put('Team', 'org:12', team(120, 12, 'read', false));
    d.put('Team', 'org:13', team(130, 13, 'admin', false));
    for (const [id, t, org] of [[1, 100, 10], [2, 110, 11], [3, 120, 12], [4, 130, 13]] as const) d.put('TeamUser', `team:${String(t)}`, {id, org_id: org, team_id: t, user_id: 1});
    d.put('Repository', 'repo:5', repo(5, dev, 'Atlas', {private: true, created_at: '2026-03-01T00:00:00Z'}));
    d.put('Repository', 'repo:6', repo(6, dev, 'old', {private: false, created_at: '2026-01-01T00:00:00Z'}));
    d.put('Repository', 'repo:7', repo(7, user(10, 'acme', 'organization'), 'go-service', {template: true}));
    d.put('Repository', 'repo:8', repo(8, user(10, 'acme', 'organization'), 'retired', {template: true, archived: true}));
    return d.pool;
  }

  test('owners: the viewer, then the organizations with an owner team or a team that may create repositories', () => {
    expect(repoOwners(setup(), 1).map((o) => o.login)).toEqual(['dev', 'acme', 'zeta']);
  });

  test('names taken on this device (case-insensitive)', () => {
    const pool = setup();
    expect(repoTaken(pool, 1, 'atlas')).toBe(true);
    expect(repoTaken(pool, 1, ' ATLAS ')).toBe(true);
    expect(repoTaken(pool, 10, 'atlas')).toBe(false);
    expect(repoTaken(pool, 1, '')).toBe(false);
    expect(loginTaken(pool, 'Acme')).toBe(true);
    expect(loginTaken(pool, 'nobody')).toBe(false);
  });

  test('templates: the template repositories that are not archived', () => {
    expect(templateRepos(setup()).map((r) => r.id)).toEqual([7]);
  });

  test('the visibility a new repository starts with ([repository] DEFAULT_PRIVATE)', () => {
    const pool = setup();
    expect(startsPrivate(pool, 1, 'last', false)).toBe(true); // the newest of the viewer's is private
    expect(startsPrivate(pool, 1, 'public', false)).toBe(false);
    expect(startsPrivate(pool, 1, 'private', false)).toBe(true);
    expect(startsPrivate(pool, 1, 'public', true)).toBe(true);
    expect(startsPrivate(pool, 99, 'last', false)).toBe(false);
  });
});

test('template lists from API v1', () => {
  expect(parseTemplates(['Go', '', 3], [{key: 'MIT', name: 'MIT'}, {name: 'x'}, null], ['Default'])).toEqual({gitignores: ['Go'], licenses: ['MIT'], labels: ['Default']});
  expect(parseTemplates(undefined, {}, null)).toEqual({gitignores: [], licenses: [], labels: []});
});

test('the new repository\'s page opens with its group held and synced; the hold goes once the page took over', async () => {
  const s = fakeSession({userId: 1});
  const app = createApp(fallbackConfig(), s);
  const asked: [string, number][] = [];
  s.data.whenSynced = (g, v) => {
    asked.push([g, v]);
    return Promise.resolve();
  };
  let heldDuring = 0;
  await openWhenSynced(app, 'repo:42', 7, () => {
    heldDuring = s.data.held.get('repo:42') ?? 0;
    return Promise.resolve();
  });
  expect(asked).toEqual([['repo:42', 7]]);
  expect(heldDuring).toBe(1);
  expect(s.data.held.has('repo:42')).toBe(false);
});
