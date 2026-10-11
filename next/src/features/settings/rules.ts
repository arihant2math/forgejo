// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings that are lists (pure; rules.test.ts): collaborators, branch
// protection rules, webhooks and deploy keys — API v1's shapes, the forms
// that edit them, the request bodies built from a form, and the checks made
// before sending. An edit sends only what changed where API v1 leaves an
// absent field alone (branch protection), so the rule's other settings
// (teams, approval lists the form does not show) are kept.

import type {FieldErrors} from './forms.ts';
import {isWebUrl} from './forms.ts';

// ---- Collaborators ----

export type Role = 'read' | 'write' | 'admin';

export const ROLES: readonly {value: Role; label: string}[] = [
  {value: 'read', label: 'Read'},
  {value: 'write', label: 'Write'},
  {value: 'admin', label: 'Admin'},
];

/** A collaborator as the page lists them. */
export interface Collaborator {
  id: number;
  login: string;
  name: string;
  avatar: string;
  role: Role;
  /**
   * The role is the pool's (Collaboration rows say "write" for an administrator: PLAN's sync scope): shown
   * until API v1 answers with the exact one.
   */
  approximate?: boolean;
}

/** API v1's access mode name (RepoCollaboratorPermission.permission) as a role. */
export function roleOf(permission: string): Role {
  if (permission === 'admin' || permission === 'owner') return 'admin';
  return permission === 'write' ? 'write' : 'read';
}

export function byLogin(a: {login: string}, b: {login: string}): number {
  return a.login.localeCompare(b.login, undefined, {sensitivity: 'base'});
}

// ---- Branch protection ----

/** API v1's BranchProtection (modules/structs/repo_branch.go). */
export interface BranchProtection {
  rule_name: string;
  branch_name?: string;
  enable_push: boolean;
  enable_push_whitelist: boolean;
  push_whitelist_usernames: string[] | null;
  push_whitelist_teams: string[] | null;
  push_whitelist_deploy_keys: boolean;
  enable_merge_whitelist: boolean;
  merge_whitelist_usernames: string[] | null;
  merge_whitelist_teams: string[] | null;
  enable_status_check: boolean;
  status_check_contexts: string[] | null;
  required_approvals: number;
  enable_approvals_whitelist: boolean;
  approvals_whitelist_username: string[] | null;
  approvals_whitelist_teams: string[] | null;
  block_on_rejected_reviews: boolean;
  block_on_official_review_requests: boolean;
  block_on_outdated_branch: boolean;
  dismiss_stale_approvals: boolean;
  ignore_stale_approvals: boolean;
  require_signed_commits: boolean;
  protected_file_patterns: string;
  unprotected_file_patterns: string;
  apply_to_admins: boolean;
  created_at: string;
  updated_at: string;
}

/** Who may push to a protected branch. */
export type PushMode = 'none' | 'writers' | 'listed';

export interface RuleForm {
  name: string;
  push: PushMode;
  /** Logins, separated by commas or spaces. */
  pushUsers: string;
  pushDeployKeys: boolean;
  /** Digits as typed. */
  approvals: string;
  dismissStale: boolean;
  blockRejected: boolean;
  blockOfficial: boolean;
  blockOutdated: boolean;
  statusCheck: boolean;
  /** Patterns, one per line. */
  statusContexts: string;
  mergeList: boolean;
  mergeUsers: string;
  signed: boolean;
  protectedFiles: string;
  unprotectedFiles: string;
  applyToAdmins: boolean;
}

/** The form for a rule, or a new rule's (pushing open to writers, nothing required: Forgejo's defaults). */
export function ruleFormOf(p?: BranchProtection): RuleForm {
  return {
    name: (p?.rule_name ?? '') || (p?.branch_name ?? ''),
    push: !p ? 'writers' : !p.enable_push ? 'none' : p.enable_push_whitelist ? 'listed' : 'writers',
    pushUsers: (p?.push_whitelist_usernames ?? []).join(', '),
    pushDeployKeys: p?.push_whitelist_deploy_keys ?? false,
    approvals: String(p?.required_approvals ?? 0),
    dismissStale: p?.dismiss_stale_approvals ?? false,
    blockRejected: p?.block_on_rejected_reviews ?? false,
    blockOfficial: p?.block_on_official_review_requests ?? false,
    blockOutdated: p?.block_on_outdated_branch ?? false,
    statusCheck: p?.enable_status_check ?? false,
    statusContexts: (p?.status_check_contexts ?? []).join('\n'),
    mergeList: p?.enable_merge_whitelist ?? false,
    mergeUsers: (p?.merge_whitelist_usernames ?? []).join(', '),
    signed: p?.require_signed_commits ?? false,
    protectedFiles: p?.protected_file_patterns ?? '',
    unprotectedFiles: p?.unprotected_file_patterns ?? '',
    applyToAdmins: p?.apply_to_admins ?? false,
  };
}

/** Logins as typed ("alice, @bob carol"): split, without "@", each once, in order. */
export function loginsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean))];
}

/** One entry per line, trimmed, without empty lines. */
export function linesOf(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** The fields of a rule API v1 takes on create (CreateBranchProtectionOption) and edit (EditBranchProtectionOption). */
export interface RuleBody {
  enable_push: boolean;
  enable_push_whitelist: boolean;
  push_whitelist_usernames: string[];
  push_whitelist_deploy_keys: boolean;
  enable_merge_whitelist: boolean;
  merge_whitelist_usernames: string[];
  enable_status_check: boolean;
  status_check_contexts: string[];
  required_approvals: number;
  block_on_rejected_reviews: boolean;
  block_on_official_review_requests: boolean;
  block_on_outdated_branch: boolean;
  dismiss_stale_approvals: boolean;
  require_signed_commits: boolean;
  protected_file_patterns: string;
  unprotected_file_patterns: string;
  apply_to_admins: boolean;
}

function ruleBody(f: RuleForm): RuleBody {
  const listed = f.push === 'listed';
  return {
    enable_push: f.push !== 'none',
    enable_push_whitelist: listed,
    push_whitelist_usernames: listed ? loginsOf(f.pushUsers) : [],
    push_whitelist_deploy_keys: listed && f.pushDeployKeys,
    enable_merge_whitelist: f.mergeList,
    merge_whitelist_usernames: f.mergeList ? loginsOf(f.mergeUsers) : [],
    enable_status_check: f.statusCheck,
    status_check_contexts: f.statusCheck ? linesOf(f.statusContexts) : [],
    required_approvals: Number(f.approvals.trim() || '0'),
    block_on_rejected_reviews: f.blockRejected,
    block_on_official_review_requests: f.blockOfficial,
    block_on_outdated_branch: f.blockOutdated,
    dismiss_stale_approvals: f.dismissStale,
    require_signed_commits: f.signed,
    protected_file_patterns: f.protectedFiles.trim(),
    unprotected_file_patterns: f.unprotectedFiles.trim(),
    apply_to_admins: f.applyToAdmins,
  };
}

/** A new rule (POST /repos/{owner}/{repo}/branch_protections). */
export function ruleCreate(f: RuleForm): RuleBody & {rule_name: string} {
  return {rule_name: f.name.trim(), ...ruleBody(f)};
}

const PUSH_FIELDS = ['enable_push', 'enable_push_whitelist', 'push_whitelist_deploy_keys'] as const;

/**
 * The changes to a rule (PATCH /repos/{owner}/{repo}/branch_protections/{name}): only the fields that differ
 * from the rule as it was, so what the form does not show (teams, approval lists) stays. API v1 reads the push
 * allowlist's switches only together with `enable_push`: a change to any of them sends all three.
 */
export function rulePatch(orig: BranchProtection, f: RuleForm): Partial<RuleBody> {
  const was = ruleBody(ruleFormOf(orig));
  const now = ruleBody(f);
  const patch: Partial<Record<keyof RuleBody, unknown>> = {};
  for (const k of Object.keys(now) as (keyof RuleBody)[]) {
    if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) patch[k] = now[k];
  }
  if (PUSH_FIELDS.some((k) => k in patch)) for (const k of PUSH_FIELDS) patch[k] = now[k];
  // An allowlist switched off keeps its logins on the server (Forgejo ignores them): nothing to send for them.
  if (!now.enable_push_whitelist) delete patch.push_whitelist_usernames;
  if (!now.enable_merge_whitelist) delete patch.merge_whitelist_usernames;
  if (!now.enable_status_check) delete patch.status_check_contexts;
  return patch as Partial<RuleBody>;
}

export function validateRule(f: RuleForm, others: readonly string[], creating: boolean): FieldErrors<keyof RuleForm> {
  const errors: FieldErrors<keyof RuleForm> = {};
  const name = f.name.trim();
  if (creating) {
    if (!name) errors.name = 'Name a branch, or a pattern such as release/*.';
    else if (/\s/.test(name)) errors.name = 'A branch name has no spaces.';
    else if (others.includes(name)) errors.name = 'There is a rule for this branch already.';
  }
  const n = f.approvals.trim();
  if (n && (!/^\d{1,4}$/.test(n))) errors.approvals = 'A whole number, 0 or more.';
  if (f.statusCheck && !linesOf(f.statusContexts).length) errors.statusContexts = 'Name at least one check (a pattern per line).';
  return errors;
}

/** What a rule requires, in a few words (its row in the list). */
export function ruleSummary(p: BranchProtection): string[] {
  const out: string[] = [];
  if (!p.enable_push) out.push('No pushing');
  else if (p.enable_push_whitelist) out.push('Pushing restricted');
  if (p.required_approvals > 0) out.push(p.required_approvals === 1 ? '1 approval' : `${String(p.required_approvals)} approvals`);
  if (p.enable_status_check) out.push('Status checks');
  if (p.require_signed_commits) out.push('Signed commits');
  if (p.block_on_outdated_branch) out.push('Up to date');
  if (p.apply_to_admins) out.push('Includes administrators');
  return out;
}

/**
 Whether a glob pattern (Forgejo's: "*" within a segment, "**" across) matches a branch name; a plain name matches itself. */
export function globMatch(pattern: string, name: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === name;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return false;
  }
}

// ---- Webhooks ----

/** API v1's Hook (modules/structs/hook.go). */
export interface Hook {
  id: number;
  type: string;
  branch_filter: string;
  url?: string;
  config: Record<string, string>;
  events: string[];
  authorization_header?: string;
  content_type?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HookEvent {
  /** The name API v1 takes (CreateHookOption.events). */
  name: string;
  /** The names API v1 lists the event under (Hook.events: Webhook.EventsArray). */
  read: readonly string[];
  label: string;
  group: 'Repository' | 'Issues' | 'Pull requests' | 'Actions';
}

/**
 * The events a webhook can be chosen for here (routers/api/v1/utils/hook.go addHook). The names written and read
 * differ for a few: "issues_only" is listed as "issues", "pull_request_only" as "pull_request", and
 * "pull_request_review" as the three review outcomes.
 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  {name: 'push', read: ['push'], label: 'Push', group: 'Repository'},
  {name: 'create', read: ['create'], label: 'Branch or tag created', group: 'Repository'},
  {name: 'delete', read: ['delete'], label: 'Branch or tag deleted', group: 'Repository'},
  {name: 'fork', read: ['fork'], label: 'Fork', group: 'Repository'},
  {name: 'repository', read: ['repository'], label: 'Repository created or deleted', group: 'Repository'},
  {name: 'release', read: ['release'], label: 'Release', group: 'Repository'},
  {name: 'wiki', read: ['wiki'], label: 'Wiki', group: 'Repository'},
  {name: 'package', read: ['package'], label: 'Package', group: 'Repository'},
  {name: 'issues_only', read: ['issues'], label: 'Opened, closed, edited', group: 'Issues'},
  {name: 'issue_assign', read: ['issue_assign'], label: 'Assigned', group: 'Issues'},
  {name: 'issue_label', read: ['issue_label'], label: 'Labelled', group: 'Issues'},
  {name: 'issue_milestone', read: ['issue_milestone'], label: 'Milestone set', group: 'Issues'},
  {name: 'issue_comment', read: ['issue_comment'], label: 'Commented', group: 'Issues'},
  {name: 'pull_request_only', read: ['pull_request'], label: 'Opened, closed, edited', group: 'Pull requests'},
  {name: 'pull_request_assign', read: ['pull_request_assign'], label: 'Assigned', group: 'Pull requests'},
  {name: 'pull_request_label', read: ['pull_request_label'], label: 'Labelled', group: 'Pull requests'},
  {name: 'pull_request_milestone', read: ['pull_request_milestone'], label: 'Milestone set', group: 'Pull requests'},
  {name: 'pull_request_comment', read: ['pull_request_comment'], label: 'Commented', group: 'Pull requests'},
  {name: 'pull_request_review', read: ['pull_request_review_approved', 'pull_request_review_rejected', 'pull_request_review_comment'], label: 'Reviewed', group: 'Pull requests'},
  {name: 'pull_request_review_request', read: ['pull_request_review_request'], label: 'Review requested', group: 'Pull requests'},
  {name: 'pull_request_sync', read: ['pull_request_sync'], label: 'Synchronized (new commits)', group: 'Pull requests'},
  {name: 'action_run_failure', read: ['action_run_failure'], label: 'Run failed', group: 'Actions'},
  {name: 'action_run_success', read: ['action_run_success'], label: 'Run recovered', group: 'Actions'},
];

const READ_NAMES = new Set(HOOK_EVENTS.flatMap((e) => e.read));

export type EventsMode = 'push' | 'all' | 'choose';

export interface HookForm {
  url: string;
  contentType: 'json' | 'form';
  /** New hooks only: API v1 cannot change a hook's secret. */
  secret: string;
  authorization: string;
  branchFilter: string;
  active: boolean;
  mode: EventsMode;
  /** The chosen events (HookEvent.name), for mode "choose". */
  events: readonly string[];
}

/** The form for a hook (its URL, content type, events), or a new hook's (JSON, push events, active). */
export function hookFormOf(h?: Hook): HookForm {
  if (!h) return {url: '', contentType: 'json', secret: '', authorization: '', branchFilter: '', active: true, mode: 'push', events: ['push']};
  const has = new Set(h.events);
  const chosen = HOOK_EVENTS.filter((e) => e.read.some((r) => has.has(r))).map((e) => e.name);
  const mode: EventsMode = chosen.length === 1 && chosen[0] === 'push' && h.events.every((e) => e === 'push') ? 'push' :
    chosen.length === HOOK_EVENTS.length ? 'all' : 'choose';
  return {
    url: h.config.url ?? h.url ?? '',
    contentType: (h.content_type ?? h.config.content_type) === 'form' ? 'form' : 'json',
    secret: '',
    authorization: h.authorization_header ?? '',
    branchFilter: h.branch_filter,
    active: h.active,
    mode,
    events: chosen,
  };
}

/**
 * The events to send. Events this form does not offer (the workflow events) are kept as they were: listed
 * under the same name they are written with. "Push only" means push only.
 */
export function hookEvents(f: HookForm, orig?: Hook): string[] {
  if (f.mode === 'push') return ['push'];
  const kept = (orig?.events ?? []).filter((e) => !READ_NAMES.has(e));
  const chosen = f.mode === 'all' ? HOOK_EVENTS.map((e) => e.name) : HOOK_EVENTS.filter((e) => f.events.includes(e.name)).map((e) => e.name);
  return [...chosen, ...kept];
}

export function validateHook(f: HookForm): FieldErrors<keyof HookForm> {
  const errors: FieldErrors<keyof HookForm> = {};
  const url = f.url.trim();
  if (!url) errors.url = 'The address Forgejo sends the events to.';
  else if (!isWebUrl(url)) errors.url = 'An address starting with http:// or https://.';
  if (f.mode === 'choose' && !f.events.length) errors.events = 'Choose at least one event.';
  if (/[\r\n]/.test(f.authorization)) errors.authorization = 'One line.';
  return errors;
}

/** A new hook of Forgejo's own type (POST /repos/{owner}/{repo}/hooks). */
export function hookCreate(f: HookForm, type = 'forgejo') {
  const config: Record<string, string> = {url: f.url.trim(), content_type: f.contentType};
  if (f.secret) config.secret = f.secret;
  return {
    type, config, events: hookEvents(f), branch_filter: f.branchFilter.trim(), active: f.active,
    ...(f.authorization.trim() ? {authorization_header: f.authorization.trim()} : {}),
  };
}

/**
 * A hook's changes (PATCH /repos/{owner}/{repo}/hooks/{id}). API v1 replaces the events and the authorization
 * header on every edit (an absent header clears it): both are always sent.
 */
export function hookPatch(f: HookForm, orig: Hook) {
  return {
    config: {url: f.url.trim(), content_type: f.contentType},
    events: hookEvents(f, orig),
    branch_filter: f.branchFilter.trim(),
    authorization_header: f.authorization.trim(),
    active: f.active,
  };
}

/** Whether this page edits a hook of this type (Forgejo's and Gitea's own; the others' options are classic). */
export function editableHook(type: string): boolean {
  return type === 'forgejo' || type === 'gitea';
}

/** A hook's events in a few words. */
export function hookSummary(h: Hook): string {
  const f = hookFormOf(h);
  if (f.mode === 'push') return 'Push events';
  if (f.mode === 'all') return 'All events';
  const n = f.events.length + h.events.filter((e) => !READ_NAMES.has(e)).length;
  return n === 1 ? '1 event' : `${String(n)} events`;
}

// ---- Deploy keys ----

/** API v1's DeployKey (modules/structs/repo_key.go). */
export interface DeployKey {
  id: number;
  key_id: number;
  key: string;
  url: string;
  title: string;
  fingerprint: string;
  created_at: string;
  read_only: boolean;
}

export interface KeyForm {
  title: string;
  key: string;
  write: boolean;
}

export function validateKey(f: KeyForm): FieldErrors<keyof KeyForm> {
  const errors: FieldErrors<keyof KeyForm> = {};
  if (!f.title.trim()) errors.title = 'Name the key (what uses it).';
  else if (f.title.trim().length > 50) errors.title = 'At most 50 characters.';
  const key = f.key.trim();
  if (!key) errors.key = 'Paste the public key (the .pub file).';
  else if (key.includes('PRIVATE KEY')) errors.key = 'This is a private key: paste the public one (the .pub file) instead.';
  else if (!/^(?:ssh-|ecdsa-|sk-|-----BEGIN SSH2 PUBLIC KEY-----)/.test(key)) errors.key = 'An SSH public key starts with ssh-, ecdsa- or sk-.';
  return errors;
}

/** A new deploy key (POST /repos/{owner}/{repo}/keys): read-only unless write access is asked for. */
export function keyCreate(f: KeyForm): {title: string; key: string; read_only: boolean} {
  return {title: f.title.trim(), key: f.key.trim(), read_only: !f.write};
}
