// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The new repository and new organization forms, as pure functions
// (forms.test.ts): what Forgejo accepts as a name (checked as you type, so
// the button says why before Forgejo would), the API v1 request each form
// sends, and what a refusal means for the person filling it in.
//
// Names follow upstream: a repository name is `binding:"AlphaDashDot"` and
// repo_model.IsUsableRepoName (reserved ".", "..", "-"; no "*.git",
// "*.wiki", "*.rss", "*.atom"); an organization name is a user name
// (validation.IsValidUsername with dots allowed, the instance default, and
// user_model.IsUsableUsername's reserved names and patterns). The server
// decides for real: this only answers sooner.

import {RequestFailed} from '../../app/api.ts';

export const REPO_NAME_MAX = 100;
export const ORG_NAME_MAX = 40;
export const DESCRIPTION_MAX = 2048;

const REPO_RESERVED = new Set(['.', '..', '-']);
const REPO_SUFFIXES = ['.git', '.wiki', '.rss', '.atom'];

/** user_model's reservedUsernames (an organization is a user). */
const USER_RESERVED = new Set([
  '.', '..', '-', '.well-known', 'api', 'metrics', 'v2', 'assets', 'attachments', 'avatar', 'avatars', 'repo-avatars', 'captcha',
  'login', 'org', 'repo', 'user', 'admin', 'explore', 'issues', 'pulls', 'milestones', 'notifications', 'report_abuse',
  'favicon.ico', 'manifest.json', 'robots.txt', 'sitemap.xml', 'ssh_info', 'swagger.v1.json', 'ghost', 'gitea-actions',
  'forgejo-actions', 'actor',
]);
const USER_SUFFIXES = ['.keys', '.gpg', '.rss', '.atom', '.png'];

/** Why Forgejo would refuse a repository name, or undefined when it is one it takes. */
export function repoNameProblem(name: string): string | undefined {
  if (!name) return 'A repository needs a name.';
  // ASCII only from here on: the length is the characters'.
  if (/[^\w.-]/.test(name)) return 'Use only letters, digits, “-”, “_” and “.”.';
  if (name.length > REPO_NAME_MAX) return `At most ${String(REPO_NAME_MAX)} characters.`;
  const lower = name.toLowerCase();
  if (REPO_RESERVED.has(lower)) return `“${name}” is reserved.`;
  const suffix = REPO_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix) return `A name cannot end in “${suffix}”.`;
  return undefined;
}

/** Why Forgejo would refuse an organization name, or undefined when it is one it takes. */
export function orgNameProblem(name: string): string | undefined {
  if (!name) return 'An organization needs a name.';
  if (/[^\w.-]/.test(name)) return 'Use only letters, digits, “-”, “_” and “.”.';
  if (name.length > ORG_NAME_MAX) return `At most ${String(ORG_NAME_MAX)} characters.`;
  if (!/^[\da-z]/i.test(name)) return 'Start with a letter or a digit.';
  if (/[-._]{2,}/.test(name)) return 'No two of “-”, “_” and “.” in a row.';
  if (/[-._]$/.test(name)) return 'End with a letter or a digit.';
  const lower = name.toLowerCase();
  if (USER_RESERVED.has(lower)) return `“${name}” is reserved.`;
  const suffix = USER_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix) return `A name cannot end in “${suffix}”.`;
  return undefined;
}

/** A name with what Forgejo does not take replaced by "-" ("My project" → "My-project"), as a suggestion. */
export function suggestName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** What a template repository passes on to the new one (API v1 GenerateRepoOption). */
export interface TemplateItems {
  git_content: boolean;
  topics: boolean;
  labels: boolean;
  webhooks: boolean;
  git_hooks: boolean;
  avatar: boolean;
  protected_branch: boolean;
}

export const TEMPLATE_ITEMS: readonly {key: keyof TemplateItems; label: string}[] = [
  {key: 'git_content', label: 'Git content (the default branch)'},
  {key: 'topics', label: 'Topics'},
  {key: 'labels', label: 'Labels'},
  {key: 'webhooks', label: 'Webhooks'},
  {key: 'git_hooks', label: 'Git hooks'},
  {key: 'avatar', label: 'Avatar'},
  {key: 'protected_branch', label: 'Protected branches'},
];

export interface NewRepoInput {
  /** The owner: the viewer, or an organization (`org`). */
  owner: {login: string; org: boolean};
  name: string;
  description: string;
  private: boolean;
  /** Generate from this template repository (the init options below then do not apply). */
  template?: {owner: string; name: string; items: TemplateItems} | undefined;
  readme: boolean;
  gitignores: readonly string[];
  license: string;
  /** A label set (API v1 /label/templates), or "". */
  labels: string;
  defaultBranch: string;
  /** "" for the instance's default. */
  objectFormat: string;
  /** The new repository is a template itself. */
  isTemplate: boolean;
}

export interface ApiRequest {
  path: string;
  body: Record<string, unknown>;
}

/** Whether the repository gets a first commit: Forgejo writes the README with a .gitignore or a license too. */
export function initializes(f: Pick<NewRepoInput, 'readme' | 'gitignores' | 'license'>): boolean {
  return f.readme || f.gitignores.length > 0 || f.license !== '';
}

/** Why a template cannot be used as chosen (Forgejo needs at least one item), or undefined. */
export function templateProblem(items: TemplateItems): string | undefined {
  return Object.values(items).some(Boolean) ? undefined : 'Choose at least one thing to take from the template.';
}

const enc = encodeURIComponent;

/**
 * The API v1 request that creates the repository: POST /repos/{template}/generate from a template, else
 * POST /orgs/{org}/repos or POST /user/repos.
 */
export function newRepoRequest(f: NewRepoInput): ApiRequest {
  const name = f.name.trim();
  const description = f.description.trim();
  const branch = f.defaultBranch.trim();
  if (f.template) {
    return {
      path: `/repos/${enc(f.template.owner)}/${enc(f.template.name)}/generate`,
      body: {owner: f.owner.login, name, description, private: f.private, ...(branch ? {default_branch: branch} : {}), ...f.template.items},
    };
  }
  const init = initializes(f);
  return {
    path: f.owner.org ? `/orgs/${enc(f.owner.login)}/repos` : '/user/repos',
    body: {
      name, description, private: f.private, template: f.isTemplate,
      auto_init: init,
      ...(init ? {readme: 'Default', gitignores: f.gitignores.join(','), license: f.license} : {}),
      ...(f.labels ? {issue_labels: f.labels} : {}),
      ...(branch ? {default_branch: branch} : {}),
      ...(f.objectFormat ? {object_format_name: f.objectFormat} : {}),
    },
  };
}

export type OrgVisibility = 'public' | 'limited' | 'private';

export interface NewOrgInput {
  name: string;
  visibility: OrgVisibility;
  /** Repository admins may add or remove the access of teams (classic "Permissions"). */
  repoAdminChangeTeamAccess: boolean;
}

/** POST /orgs. */
export function newOrgRequest(f: NewOrgInput): ApiRequest {
  return {path: '/orgs', body: {username: f.name.trim(), visibility: f.visibility, repo_admin_change_team_access: f.repoAdminChangeTeamAccess}};
}

/**
 * The token scope API v1 asks for to create a repository (also from a template: upstream ties it to the owner)
 * or an organization: write:user for the viewer's own, write:organization for an organization's.
 */
export function creationScope(org: boolean): 'write:user' | 'write:organization' {
  return org ? 'write:organization' : 'write:user';
}

/**
 * Whether the UI's sign-in (the OAuth scope in its config) carries `need`. The UI deliberately asks for no write
 * access to the account or organizations (PLAN §4.9, services/livesync/oauthapp Scope): then the form says so
 * up front and points at the classic page instead of failing on submit. Unknown (no OAuth config): Forgejo decides.
 */
export function scopeAllows(granted: string | undefined, need: string): boolean {
  if (granted === undefined) return true;
  const scopes = granted.split(/[\s,]+/).filter(Boolean);
  return scopes.includes('all') || scopes.includes(need);
}

/** A refusal, for the form: about the name (shown under it) or the whole form (shown above the button). */
export interface Refusal {
  field: 'name' | 'form';
  text: string;
}

/**
 * What Forgejo's refusal of a new repository means. API v1 answers 409 for a name in use, 422 for a reserved
 * name or pattern, 403 for an organization the viewer may not create in, 413 for a full quota — and 500 for
 * the viewer's repository limit (ErrReachLimitOfRepo is not mapped; its message is only shown to site
 * administrators), which is the usual reason for a 500 there (user_model.CanCreateRepo's note).
 */
export function repoRefusal(err: unknown): Refusal {
  const status = err instanceof RequestFailed ? err.status : 0;
  const said = err instanceof Error ? err.message : '';
  const limit = /maximum limit of repositories \[limit: (-?\d+)\]/.exec(said);
  if (limit) {
    const n = Number(limit[1]);
    return {field: 'form', text: `You have reached the number of repositories you may create${n >= 0 ? ` (${String(n)})` : ''}.`};
  }
  if (status === 409) return {field: 'name', text: 'A repository with this name already exists.'};
  if (status === 422 && /name|reserved|pattern/i.test(said)) return {field: 'name', text: nameRefusal(said)};
  if (status === 413) return {field: 'form', text: 'The owner’s storage quota is used up: Forgejo takes no new repository.'};
  if (status === 403 && /scope/i.test(said)) return {field: 'form', text: SCOPE_REFUSAL};
  if (status === 403) return {field: 'form', text: said && !said.startsWith('Forgejo answered') ? said : 'You may not create repositories for this owner.'};
  if (status >= 500 && (!said || said.startsWith('Forgejo answered'))) {
    return {field: 'form', text: 'Forgejo did not create the repository. You may have reached the number of repositories you may create (a site administrator can raise it), or Forgejo ran into an error.'};
  }
  return {field: 'form', text: said || 'Forgejo could not be reached.'};
}

/** What Forgejo's refusal of a new organization means (API v1: 422 for the name, 403 when not allowed). */
export function orgRefusal(err: unknown): Refusal {
  const status = err instanceof RequestFailed ? err.status : 0;
  const said = err instanceof Error ? err.message : '';
  if (status === 422 && /already exists/i.test(said)) return {field: 'name', text: 'This name is taken by a user or an organization.'};
  if (status === 422 && /name|reserved|pattern|character/i.test(said)) return {field: 'name', text: nameRefusal(said)};
  if (status === 403 && /scope/i.test(said)) return {field: 'form', text: SCOPE_REFUSAL};
  if (status === 403) return {field: 'form', text: 'Your account may not create organizations.'};
  if (status >= 500 && (!said || said.startsWith('Forgejo answered'))) return {field: 'form', text: 'Forgejo did not create the organization: it ran into an error.'};
  return {field: 'form', text: said || 'Forgejo could not be reached.'};
}

const SCOPE_REFUSAL = 'Forgejo Next’s sign-in may not do this (its token has no write access to your account or organizations). Use the classic form.';

function nameRefusal(said: string): string {
  const reserved = /name is reserved \[name: (.*)\]/.exec(said);
  if (reserved) return `“${reserved[1] ?? ''}” is reserved.`;
  const pattern = /pattern is not allowed \[pattern: (.*)\]/.exec(said);
  if (pattern) return `Names like “${pattern[1] ?? ''}” are not allowed.`;
  return said || 'Forgejo does not take this name.';
}
