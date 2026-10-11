// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {eachLimited} from './resource.ts';
import {storedHooks} from './requests.ts';
import {
  type BranchProtection, globMatch, type Hook, hookCreate, hookEvents, hookFormOf, hookPatch, hookSummary, HOOK_EVENTS, keyCreate, linesOf, loginsOf, roleOf,
  ruleCreate, ruleFormOf, rulePatch, ruleSummary, validateHook, validateKey, validateRule,
} from './rules.ts';

function rule(extra: Partial<BranchProtection> = {}): BranchProtection {
  return {
    rule_name: 'main', enable_push: true, enable_push_whitelist: false, push_whitelist_usernames: null, push_whitelist_teams: ['core'],
    push_whitelist_deploy_keys: false, enable_merge_whitelist: false, merge_whitelist_usernames: null, merge_whitelist_teams: null, enable_status_check: false,
    status_check_contexts: null, required_approvals: 0, enable_approvals_whitelist: true, approvals_whitelist_username: ['lead'], approvals_whitelist_teams: null,
    block_on_rejected_reviews: false, block_on_official_review_requests: false, block_on_outdated_branch: false, dismiss_stale_approvals: false,
    ignore_stale_approvals: false, require_signed_commits: false, protected_file_patterns: '', unprotected_file_patterns: '', apply_to_admins: false,
    created_at: '', updated_at: '', ...extra,
  };
}

test('roles', () => {
  expect(['owner', 'admin', 'write', 'read', 'none'].map(roleOf)).toEqual(['admin', 'admin', 'write', 'read', 'read']);
});

describe('branch protection', () => {
  test('logins and lines as typed', () => {
    expect(loginsOf('alice, @bob  carol,alice')).toEqual(['alice', 'bob', 'carol']);
    expect(linesOf(' ci/build \n\n lint\n')).toEqual(['ci/build', 'lint']);
  });

  test('a new rule: the whole body', () => {
    const f = {...ruleFormOf(), name: ' release/* ', push: 'listed' as const, pushUsers: 'alice, bob', pushDeployKeys: true, approvals: '2', statusCheck: true, statusContexts: 'ci/*'};
    expect(ruleCreate(f)).toMatchObject({
      rule_name: 'release/*', enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ['alice', 'bob'], push_whitelist_deploy_keys: true,
      required_approvals: 2, enable_status_check: true, status_check_contexts: ['ci/*'],
    });
    expect(ruleCreate({...ruleFormOf(), name: 'main', push: 'none'})).toMatchObject({enable_push: false, enable_push_whitelist: false, push_whitelist_usernames: []});
  });

  test('an edit sends only what changed (teams and approval lists are left alone)', () => {
    const r = rule();
    expect(rulePatch(r, ruleFormOf(r))).toEqual({});
    expect(rulePatch(r, {...ruleFormOf(r), approvals: '1', signed: true})).toEqual({required_approvals: 1, require_signed_commits: true});
    // The push switches go together: API v1 reads the allowlist's only with enable_push.
    expect(rulePatch(r, {...ruleFormOf(r), push: 'listed', pushUsers: 'alice'})).toEqual({
      enable_push: true, enable_push_whitelist: true, push_whitelist_deploy_keys: false, push_whitelist_usernames: ['alice'],
    });
    expect(rulePatch(r, {...ruleFormOf(r), push: 'none'})).toEqual({enable_push: false, enable_push_whitelist: false, push_whitelist_deploy_keys: false});
    const listed = rule({enable_push_whitelist: true, push_whitelist_usernames: ['alice']});
    expect(rulePatch(listed, {...ruleFormOf(listed), pushUsers: 'alice, bob'})).toEqual({push_whitelist_usernames: ['alice', 'bob']});
    // Status checks turned off: their patterns are not sent.
    const checks = rule({enable_status_check: true, status_check_contexts: ['ci']});
    expect(rulePatch(checks, {...ruleFormOf(checks), statusCheck: false})).toEqual({enable_status_check: false});
  });

  test('checks before sending', () => {
    const f = ruleFormOf();
    expect(validateRule({...f, name: ''}, [], true).name).toBeTruthy();
    expect(validateRule({...f, name: 'main'}, ['main'], true).name).toMatch(/already/);
    expect(validateRule({...f, name: 'a b'}, [], true).name).toBeTruthy();
    expect(validateRule({...f, name: 'main'}, ['main'], false)).toEqual({});
    expect(validateRule({...f, name: 'x', approvals: '-1'}, [], true).approvals).toBeTruthy();
    expect(validateRule({...f, name: 'x', statusCheck: true, statusContexts: ' '}, [], true).statusContexts).toBeTruthy();
  });

  test('a rule in a few words', () => {
    expect(ruleSummary(rule())).toEqual([]);
    expect(ruleSummary(rule({enable_push: false, required_approvals: 2, enable_status_check: true, apply_to_admins: true})))
      .toEqual(['No pushing', '2 approvals', 'Status checks', 'Includes administrators']);
  });

  test('glob patterns as Forgejo matches them', () => {
    expect(globMatch('main', 'main')).toBe(true);
    expect(globMatch('main', 'main2')).toBe(false);
    expect(globMatch('release/*', 'release/1.0')).toBe(true);
    expect(globMatch('release/*', 'release/1.0/x')).toBe(false);
    expect(globMatch('release/**', 'release/1.0/x')).toBe(true);
    expect(globMatch('v?.x', 'v1.x')).toBe(true);
    expect(globMatch('a.b*', 'aXb')).toBe(false);
  });
});

describe('webhooks', () => {
  const hook = (events: string[], extra: Partial<Hook> = {}): Hook => ({
    id: 3, type: 'forgejo', branch_filter: '*', config: {url: 'https://ci.example/hook', content_type: 'json'}, events, authorization_header: 'Bearer x',
    content_type: 'json', active: true, created_at: '', updated_at: '', ...extra,
  });

  test('the form of a hook: events read under their listed names', () => {
    expect(hookFormOf(hook(['push']))).toMatchObject({url: 'https://ci.example/hook', contentType: 'json', mode: 'push', events: ['push'], authorization: 'Bearer x'});
    const f = hookFormOf(hook(['issues', 'pull_request', 'pull_request_review_approved', 'pull_request_review_rejected', 'pull_request_review_comment']));
    expect(f.mode).toBe('choose');
    expect(f.events).toEqual(['issues_only', 'pull_request_only', 'pull_request_review']);
    const all = hookFormOf(hook(HOOK_EVENTS.flatMap((e) => e.read)));
    expect(all.mode).toBe('all');
    expect(hookFormOf(hook([], {content_type: 'form'})).contentType).toBe('form');
  });

  test('events sent: what the form offers, and what it does not offer kept', () => {
    const orig = hook(['push', 'workflow_run_failure']);
    expect(hookEvents({...hookFormOf(orig), mode: 'choose', events: ['push', 'issue_comment']}, orig)).toEqual(['push', 'issue_comment', 'workflow_run_failure']);
    expect(hookEvents({...hookFormOf(orig), mode: 'push'}, orig)).toEqual(['push']);
    expect(hookEvents({...hookFormOf(orig), mode: 'all'}, orig)).toEqual([...HOOK_EVENTS.map((e) => e.name), 'workflow_run_failure']);
    expect(hookSummary(orig)).toBe('2 events');
    expect(hookSummary(hook(['push']))).toBe('Push events');
  });

  test('create and edit bodies', () => {
    const f = {...hookFormOf(), url: ' https://x.example/h ', secret: 's3', authorization: ' Bearer t '};
    expect(hookCreate(f)).toEqual({
      type: 'forgejo', config: {url: 'https://x.example/h', content_type: 'json', secret: 's3'}, events: ['push'], branch_filter: '', active: true, authorization_header: 'Bearer t',
    });
    expect(hookCreate({...f, secret: '', authorization: ''})).not.toHaveProperty('authorization_header');
    // The header is always sent on edit: API v1 clears it otherwise.
    const orig = hook(['push']);
    expect(hookPatch({...hookFormOf(orig), active: false}, orig)).toEqual({
      config: {url: 'https://ci.example/hook', content_type: 'json'}, events: ['push'], branch_filter: '*', authorization_header: 'Bearer x', active: false,
    });
  });

  test('checks before sending', () => {
    const f = hookFormOf();
    expect(validateHook(f).url).toBeTruthy();
    expect(validateHook({...f, url: 'ftp://x'}).url).toBeTruthy();
    expect(validateHook({...f, url: 'https://x.example'})).toEqual({});
    expect(validateHook({...f, url: 'https://x.example', mode: 'choose', events: []}).events).toBeTruthy();
    expect(validateHook({...f, url: 'https://x.example', authorization: 'a\nb'}).authorization).toBeTruthy();
  });

  test('authorization headers are not written to IndexedDB', () => {
    expect(storedHooks([hook(['push'])])[0]).not.toHaveProperty('authorization_header');
  });
});

describe('deploy keys', () => {
  test('checks and body', () => {
    expect(validateKey({title: '', key: '', write: false})).toMatchObject({title: expect.any(String) as string, key: expect.any(String) as string});
    expect(validateKey({title: 'ci', key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc', write: false}).key).toMatch(/private key/);
    expect(validateKey({title: 'ci', key: 'hello', write: false}).key).toBeTruthy();
    expect(validateKey({title: 'ci', key: 'ssh-ed25519 AAAAC3Nza dev@host', write: false})).toEqual({});
    expect(keyCreate({title: ' ci ', key: ' ssh-ed25519 AAAA ', write: true})).toEqual({title: 'ci', key: 'ssh-ed25519 AAAA', read_only: false});
  });
});

test('at most n requests at a time, answers in order', async () => {
  let running = 0;
  let most = 0;
  const out = await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    return n * 2;
  });
  expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  expect(most).toBe(3);
});
