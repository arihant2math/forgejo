// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as P from '../protocol/types.gen.ts';

export interface ModelTypes {
  Repository: P.Repository;
  User: P.User;
  OrgUser: P.OrgUser;
  Team: P.Team;
  TeamUser: P.TeamUser;
  TeamRepo: P.TeamRepo;
  TeamUnit: P.TeamUnit;
  Collaboration: P.Collaboration;
  Access: P.Access;
  RepoUnit: P.RepoUnit;
  Label: P.Label;
  Milestone: P.Milestone;
  Project: P.Project;
  ProjectRef: P.ProjectRef;
  ProjectColumn: P.ProjectColumn;
  ProjectIssue: P.ProjectIssue;
  Issue: P.Issue;
  IssueBody: P.IssueBody;
  IssueLabel: P.IssueLabel;
  IssueAssignee: P.IssueAssignee;
  PullRequest: P.PullRequest;
  AutoMerge: P.AutoMerge;
  Branch: P.Branch;
  Release: P.Release;
  CommitStatus: P.CommitStatus;
  ActionRun: P.ActionRun;
  ActionRunJob: P.ActionRunJob;
  Notification: P.Notification;
  Stopwatch: P.Stopwatch;
  IssueWatch: P.IssueWatch;
  Watch: P.Watch;
  Star: P.Star;
  BlockedUser: P.BlockedUser;
  Comment: P.Comment;
  Reaction: P.Reaction;
  Review: P.Review;
  ReviewVerdict: P.ReviewVerdict;
  ReviewState: P.ReviewState;
  Attachment: P.Attachment;
  IssueDependency: P.IssueDependency;
  TrackedTime: P.TrackedTime;
  ContentHistory: P.ContentHistory;
}

export type ModelName = keyof ModelTypes;

export type GroupKind = 'user' | 'org' | 'repo' | 'issue' | 'profile' | 'profiles' | 'owner' | 'team';

interface ModelDef {
  /** Schema version this client understands (protocol.Schema*). */
  schema: number;
  kinds: readonly GroupKind[];
  /** Fields indexed in the pool (`ModelStore.by`). */
  index?: readonly string[];
}

// Keep placement rules aligned with services/livesync/hub/models.go (checked by models.test.ts).
const defs = {
  Repository: {schema: P.SchemaRepository, kinds: ['repo'], index: ['owner_id', 'full_name']},
  User: {schema: P.SchemaUser, kinds: ['org', 'profile', 'profiles'], index: ['login']},
  OrgUser: {schema: P.SchemaOrgUser, kinds: ['org'], index: ['org_id', 'user_id']},
  Team: {schema: P.SchemaTeam, kinds: ['org'], index: ['org_id']},
  TeamUser: {schema: P.SchemaTeamUser, kinds: ['team', 'org'], index: ['team_id', 'user_id']},
  TeamRepo: {schema: P.SchemaTeamRepo, kinds: ['team', 'org'], index: ['team_id', 'repo_id']},
  TeamUnit: {schema: P.SchemaTeamUnit, kinds: ['org'], index: ['team_id']},
  Collaboration: {schema: P.SchemaCollaboration, kinds: ['repo'], index: ['repo_id', 'user_id']},
  Access: {schema: P.SchemaAccess, kinds: ['user'], index: ['repo_id']},
  RepoUnit: {schema: P.SchemaRepoUnit, kinds: ['repo'], index: ['repo_id']},
  Label: {schema: P.SchemaLabel, kinds: ['repo', 'owner', 'org'], index: ['repo_id', 'org_id']},
  Milestone: {schema: P.SchemaMilestone, kinds: ['repo'], index: ['repo_id']},
  Project: {schema: P.SchemaProject, kinds: ['repo', 'owner', 'org', 'profile'], index: ['repo_id', 'owner_id']},
  ProjectRef: {schema: P.SchemaProjectRef, kinds: ['owner'], index: ['owner_id']},
  ProjectColumn: {schema: P.SchemaProjectColumn, kinds: ['repo', 'org', 'profile'], index: ['project_id']},
  ProjectIssue: {schema: P.SchemaProjectIssue, kinds: ['repo'], index: ['issue_id', 'project_id']},
  Issue: {schema: P.SchemaIssue, kinds: ['repo'], index: ['repo_id', 'number', 'poster_id']},
  IssueBody: {schema: P.SchemaIssueBody, kinds: ['issue']},
  IssueLabel: {schema: P.SchemaIssueLabel, kinds: ['repo'], index: ['issue_id', 'label_id']},
  IssueAssignee: {schema: P.SchemaIssueAssignee, kinds: ['repo'], index: ['issue_id', 'assignee_id']},
  PullRequest: {schema: P.SchemaPullRequest, kinds: ['repo'], index: ['issue_id', 'base_repo_id', 'head_repo_id']},
  AutoMerge: {schema: P.SchemaAutoMerge, kinds: ['repo'], index: ['pull_id']},
  Branch: {schema: P.SchemaBranch, kinds: ['repo'], index: ['repo_id']},
  Release: {schema: P.SchemaRelease, kinds: ['repo'], index: ['repo_id']},
  CommitStatus: {schema: P.SchemaCommitStatus, kinds: ['repo'], index: ['repo_id', 'sha']},
  ActionRun: {schema: P.SchemaActionRun, kinds: ['repo'], index: ['repo_id', 'commit_sha']},
  ActionRunJob: {schema: P.SchemaActionRunJob, kinds: ['repo'], index: ['run_id']},
  Notification: {schema: P.SchemaNotification, kinds: ['user'], index: ['repo_id', 'issue_id', 'status']},
  Stopwatch: {schema: P.SchemaStopwatch, kinds: ['user'], index: ['issue_id']},
  IssueWatch: {schema: P.SchemaIssueWatch, kinds: ['user'], index: ['issue_id']},
  Watch: {schema: P.SchemaWatch, kinds: ['user'], index: ['repo_id']},
  Star: {schema: P.SchemaStar, kinds: ['user'], index: ['repo_id']},
  BlockedUser: {schema: P.SchemaBlockedUser, kinds: ['user'], index: ['block_id']},
  Comment: {schema: P.SchemaComment, kinds: ['issue', 'user'], index: ['issue_id', 'review_id']},
  Reaction: {schema: P.SchemaReaction, kinds: ['issue', 'user'], index: ['issue_id', 'comment_id']},
  Review: {schema: P.SchemaReview, kinds: ['issue', 'user'], index: ['issue_id', 'reviewer_id']},
  ReviewVerdict: {schema: P.SchemaReviewVerdict, kinds: ['repo'], index: ['issue_id']},
  ReviewState: {schema: P.SchemaReviewState, kinds: ['user'], index: ['pull_id']},
  Attachment: {schema: P.SchemaAttachment, kinds: ['issue', 'user', 'repo'], index: ['issue_id', 'comment_id', 'release_id']},
  IssueDependency: {schema: P.SchemaIssueDependency, kinds: ['issue'], index: ['issue_id', 'dependency_id']},
  TrackedTime: {schema: P.SchemaTrackedTime, kinds: ['user', 'issue'], index: ['issue_id']},
  ContentHistory: {schema: P.SchemaContentHistory, kinds: ['issue', 'user'], index: ['issue_id', 'comment_id']},
} as const satisfies Record<ModelName, ModelDef>;

/** The catalogue with its literal types (pool index fields are typed from it). */
export type ModelDefs = typeof defs;
export const MODELS: Readonly<Record<ModelName, ModelDef>> = defs;
export const MODEL_NAMES = Object.keys(defs) as ModelName[];

export function isModel(m: string): m is ModelName {
  return Object.hasOwn(defs, m);
}

export function clientSchemas(): Record<ModelName, number> {
  const out = {} as Record<ModelName, number>;
  for (const m of MODEL_NAMES) out[m] = MODELS[m].schema;
  return out;
}

/** Group kinds named by a numeric id. */
export type IdGroupKind = Exclude<GroupKind, 'profiles'>;

const PREFIXES = new Map<string, IdGroupKind>([
  [P.GroupPrefixUser, 'user'], [P.GroupPrefixOrg, 'org'], [P.GroupPrefixRepo, 'repo'], [P.GroupPrefixIssue, 'issue'],
  [P.GroupPrefixProfile, 'profile'], [P.GroupPrefixOwner, 'owner'], [P.GroupPrefixTeam, 'team'],
]);

/** A group's name (protocol.GroupName). */
export function groupName(kind: IdGroupKind, id: number): string {
  return `${kind}:${String(id)}`;
}

export const repoGroup = (repoId: number): string => groupName('repo', repoId);
export const issueGroup = (issueId: number): string => groupName('issue', issueId);

/** The kind of a group name, or undefined for pseudo groups and malformed names (protocol.ParseGroup). */
export function groupKind(group: string): GroupKind | undefined {
  if (group === P.GroupProfilesPublic || group === P.GroupProfilesLimited) return 'profiles';
  const i = group.indexOf(':');
  if (i < 0) return undefined;
  if (!/^[1-9][0-9]*$/.test(group.slice(i + 1))) return undefined;
  return PREFIXES.get(group.slice(0, i));
}

/** The repository id of a `repo:<id>` group, else undefined. */
export function repoOfGroup(group: string): number | undefined {
  return groupKind(group) === 'repo' ? groupId(group) : undefined;
}

/** The numeric id of a group name (0 for the profile directories, NaN when malformed). */
export function groupId(group: string): number {
  const kind = groupKind(group);
  if (kind === undefined) return Number.NaN;
  return kind === 'profiles' ? 0 : Number(group.slice(group.indexOf(':') + 1));
}

export function canHold(kind: GroupKind, model: ModelName): boolean {
  return (MODELS[model].kinds).includes(kind);
}

export function modelsOfKind(kind: GroupKind): ModelName[] {
  return MODEL_NAMES.filter((m) => canHold(kind, m));
}

/** Small groups hydrated before the idle background pass. */
export const STRUCTURE_KINDS: readonly GroupKind[] = ['user', 'profile', 'profiles', 'org', 'owner'];
