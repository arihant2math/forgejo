// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's general settings as forms (pure; forms.test.ts): what the
// pool says (Repository, RepoUnit) → the form's values, the form → the
// smallest API v1 `PATCH /repos/{owner}/{repo}` body (EditRepoOption: only
// the fields that change are sent, so a save never overwrites a change
// someone else made to another field), the checks made before sending, and
// the server's 422 answers → the field they are about.

import type {Repository} from '../../protocol/types.gen.ts';

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type MergeStyle = 'merge' | 'rebase' | 'rebase-merge' | 'squash' | 'fast-forward-only' | 'manually-merged';

/** EditRepoOption (modules/structs/repo.go), the fields the settings pages change. */
export interface RepoPatch {
  name?: string;
  description?: string;
  website?: string;
  template?: boolean;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  has_issues?: boolean;
  has_wiki?: boolean;
  has_pull_requests?: boolean;
  has_projects?: boolean;
  has_releases?: boolean;
  has_packages?: boolean;
  has_actions?: boolean;
  allow_merge_commits?: boolean;
  allow_rebase?: boolean;
  allow_rebase_explicit?: boolean;
  allow_squash_merge?: boolean;
  allow_fast_forward_only_merge?: boolean;
  allow_manual_merge?: boolean;
  default_merge_style?: MergeStyle;
  default_delete_branch_after_merge?: boolean;
  allow_rebase_update?: boolean;
  default_allow_maintainer_edit?: boolean;
}

// ---- Name, description, website, template ----

export interface Details {
  name: string;
  description: string;
  website: string;
  template: boolean;
}

export function detailsOf(r: Repository): Details {
  return {name: r.name, description: r.description, website: r.website, template: r.template};
}

export function sameDetails(a: Details, b: Details): boolean {
  return a.name === b.name && a.description === b.description && a.website === b.website && a.template === b.template;
}

/** What is typed, as it is sent (surrounding spaces dropped). */
function clean(d: Details): Details {
  return {name: d.name.trim(), description: d.description.trim(), website: d.website.trim(), template: d.template};
}

/** The fields that changed from `base` (what the form was filled with), as EditRepoOption. */
export function detailsPatch(base: Details, form: Details): RepoPatch {
  const b = clean(base);
  const f = clean(form);
  const patch: RepoPatch = {};
  if (f.name !== b.name) patch.name = f.name;
  if (f.description !== b.description) patch.description = f.description;
  if (f.website !== b.website) patch.website = f.website;
  if (f.template !== b.template) patch.template = f.template;
  return patch;
}

/** repo_model.IsUsableRepoName: the characters, and the names and suffixes Forgejo reserves. */
const NAME_CHARS = /^[\w.-]+$/;
const RESERVED_NAMES = new Set(['.', '..', '-']);
const RESERVED_SUFFIX = /\.(?:git|wiki|rss|atom)$/i;

/** The checks Forgejo makes too (binding and IsUsableRepoName), made before sending. */
export function validateDetails(form: Details): FieldErrors<keyof Details> {
  const f = clean(form);
  const errors: FieldErrors<keyof Details> = {};
  if (!f.name) errors.name = 'A repository needs a name.';
  else if (f.name.length > 100) errors.name = 'At most 100 characters.';
  else if (!NAME_CHARS.test(f.name)) errors.name = 'Use only letters, digits, “-”, “_” and “.”.';
  else if (RESERVED_NAMES.has(f.name) || /\.{2}/.test(f.name)) errors.name = 'This name is not allowed.';
  else if (RESERVED_SUFFIX.test(f.name)) errors.name = 'A name cannot end in .git, .wiki, .rss or .atom.';
  if (f.description.length > 2048) errors.description = 'At most 2048 characters.';
  if (f.website) {
    if (f.website.length > 1024) errors.website = 'At most 1024 characters.';
    else if (!isWebUrl(f.website)) errors.website = 'An address starting with http:// or https://.';
  }
  return errors;
}

/** An absolute http(s) URL. */
export function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

// ---- Features (units) ----

export type FeatureKey = 'has_issues' | 'has_pull_requests' | 'has_wiki' | 'has_projects' | 'has_releases' | 'has_packages' | 'has_actions';

export interface Feature {
  key: FeatureKey;
  /** The unit (RepoUnit.type) that is enabled while the feature is on. */
  unit: string;
  /** Its external variant (an external tracker or wiki): configured in the classic UI only. */
  external?: string;
  label: string;
  description: string;
}

export const FEATURES: readonly Feature[] = [
  {key: 'has_issues', unit: 'issues', external: 'ext_issues', label: 'Issues', description: 'Track bugs, tasks and ideas.'},
  {key: 'has_pull_requests', unit: 'pulls', label: 'Pull requests', description: 'Propose, review and merge changes.'},
  {key: 'has_wiki', unit: 'wiki', external: 'ext_wiki', label: 'Wiki', description: 'Pages of documentation next to the code.'},
  {key: 'has_projects', unit: 'projects', label: 'Projects', description: 'Boards that organise issues and pull requests.'},
  {key: 'has_releases', unit: 'releases', label: 'Releases', description: 'Published versions with notes and files.'},
  {key: 'has_packages', unit: 'packages', label: 'Packages', description: 'Packages published from this repository.'},
  {key: 'has_actions', unit: 'actions', label: 'Actions', description: 'Workflows that run on pushes and pull requests.'},
];

/** Whether a feature is on (its unit or its external variant is enabled) and whether it is the external one. */
export function featureState(units: ReadonlySet<string>, f: Feature): {on: boolean; external: boolean} {
  const external = f.external !== undefined && units.has(f.external);
  return {on: units.has(f.unit) || external, external};
}

// ---- Pull requests: merge styles and defaults ----

export interface MergeStyleInfo {
  style: MergeStyle;
  key: 'allow_merge_commits' | 'allow_rebase' | 'allow_rebase_explicit' | 'allow_squash_merge' | 'allow_fast_forward_only_merge' | 'allow_manual_merge';
  /** Its field in the pull requests unit's config (repo_model.PullRequestsConfig). */
  config: string;
  label: string;
  description: string;
}

export const MERGE_STYLES: readonly MergeStyleInfo[] = [
  {style: 'merge', key: 'allow_merge_commits', config: 'AllowMerge', label: 'Create a merge commit', description: 'All commits of the branch, joined by a merge commit.'},
  {style: 'rebase', key: 'allow_rebase', config: 'AllowRebase', label: 'Rebase', description: 'The commits replayed onto the base branch, no merge commit.'},
  {style: 'rebase-merge', key: 'allow_rebase_explicit', config: 'AllowRebaseMerge', label: 'Rebase, then create a merge commit', description: 'Replayed, then joined by a merge commit (--no-ff).'},
  {style: 'squash', key: 'allow_squash_merge', config: 'AllowSquash', label: 'Squash', description: 'All commits combined into one.'},
  {style: 'fast-forward-only', key: 'allow_fast_forward_only_merge', config: 'AllowFastForwardOnly', label: 'Fast-forward only', description: 'Only when the base branch has not moved.'},
  {style: 'manually-merged', key: 'allow_manual_merge', config: 'AllowManualMerge', label: 'Mark as merged manually', description: 'For changes merged outside Forgejo.'},
];

export interface PullSettings {
  allowed: Record<MergeStyle, boolean>;
  defaultStyle: MergeStyle;
  deleteBranch: boolean;
  rebaseUpdate: boolean;
  maintainerEdit: boolean;
}

const STYLES = new Set<string>(MERGE_STYLES.map((m) => m.style));

/** The pull requests unit's config (RepoUnit.config) as settings; Forgejo's defaults for what it lacks. */
export function pullSettingsOf(config: Readonly<Record<string, unknown>>): PullSettings {
  const flag = (k: string, dflt: boolean) => (typeof config[k] === 'boolean' ? config[k] : dflt);
  const allowed = Object.fromEntries(MERGE_STYLES.map((m) => [m.style, flag(m.config, true)])) as Record<MergeStyle, boolean>;
  const d = config.DefaultMergeStyle;
  return {
    allowed,
    defaultStyle: typeof d === 'string' && STYLES.has(d) ? d as MergeStyle : 'merge',
    deleteBranch: flag('DefaultDeleteBranchAfterMerge', false),
    rebaseUpdate: flag('AllowRebaseUpdate', true),
    maintainerEdit: flag('DefaultAllowMaintainerEdit', false),
  };
}

/** The styles a pull request can be merged with (marking one merged by hand is not one). */
const MERGING = MERGE_STYLES.filter((m) => m.style !== 'manually-merged');

/**
 * Allowing or disallowing a merge style: the body to send, or why not. The last way of merging cannot be
 * disallowed; disallowing the default style makes the first style still allowed the default (Forgejo would
 * otherwise offer a style it refuses).
 */
export function mergeStyleToggle(s: PullSettings, style: MergeStyle, on: boolean): {patch: RepoPatch} | {error: string} {
  const info = MERGE_STYLES.find((m) => m.style === style);
  if (!info) return {error: 'Unknown merge style.'};
  const patch: RepoPatch = {[info.key]: on};
  if (on) return {patch};
  const rest = MERGING.filter((m) => m.style !== style && s.allowed[m.style]);
  if (style !== 'manually-merged' && rest.length === 0) return {error: 'At least one way of merging must stay allowed.'};
  if (s.defaultStyle === style && rest[0]) patch.default_merge_style = rest[0].style;
  return {patch};
}

/** The styles the default can be (the allowed ones, and the current default even if it is not). */
export function defaultStyleChoices(s: PullSettings): MergeStyleInfo[] {
  return MERGE_STYLES.filter((m) => s.allowed[m.style] || m.style === s.defaultStyle);
}

// ---- Transfer ----

/** A transfer's new owner as typed (a login, maybe with "@"), or why it cannot be one. */
export function newOwnerOf(typed: string, current: string): {owner: string} | {error: string} {
  const owner = typed.trim().replace(/^@/, '');
  if (!owner) return {error: 'Name the new owner.'};
  if (!/^[\w.-]+$/.test(owner)) return {error: 'A user or organization name has only letters, digits, “-”, “_” and “.”.'};
  if (owner.toLowerCase() === current.toLowerCase()) return {error: 'The repository already belongs to them.'};
  return {owner};
}
