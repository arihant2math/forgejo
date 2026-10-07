// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package protocol defines livesync's wire types (PLAN §4.4, §4.6): the
// normalized, viewer-independent entity DTOs the materializer writes to the
// sync log, the sync group names and the units that gate repository-scoped
// entities. The TypeScript client's types are generated from this package
// (next/tools/gen-protocol.sh → next/src/protocol/types.gen.ts); keep it free
// of anything tygo cannot translate (functions are ignored by tygo, so only
// put small, pure helpers here).
//
// Conventions: JSON field names follow API v1 (snake_case, the same name as
// the corresponding API v1 field where one exists); references to other
// entities are ids (normalized, never embedded objects); times are RFC 3339
// strings in UTC; optional times are omitted when unset.
package protocol

import (
	"strconv"
)

// Model names an entity type. It is written to livesync_log.model and is
// the "m" of a delta change.
type Model string

// The models. Each catalogued table maps to one model (catalog.Table.Model);
// IssueBody is the lazy-tier companion of Issue (same id), kept apart so the
// summary bootstrap does not carry issue bodies.

const (
	ModelRepository      Model = "Repository"
	ModelUser            Model = "User"
	ModelOrgUser         Model = "OrgUser"
	ModelTeam            Model = "Team"
	ModelTeamUser        Model = "TeamUser"
	ModelTeamRepo        Model = "TeamRepo"
	ModelTeamUnit        Model = "TeamUnit"
	ModelCollaboration   Model = "Collaboration"
	ModelAccess          Model = "Access"
	ModelRepoUnit        Model = "RepoUnit"
	ModelLabel           Model = "Label"
	ModelMilestone       Model = "Milestone"
	ModelProject         Model = "Project"
	ModelProjectColumn   Model = "ProjectColumn"
	ModelProjectIssue    Model = "ProjectIssue"
	ModelIssue           Model = "Issue"
	ModelIssueBody       Model = "IssueBody"
	ModelIssueLabel      Model = "IssueLabel"
	ModelIssueAssignee   Model = "IssueAssignee"
	ModelPullRequest     Model = "PullRequest"
	ModelAutoMerge       Model = "AutoMerge"
	ModelBranch          Model = "Branch"
	ModelRelease         Model = "Release"
	ModelCommitStatus    Model = "CommitStatus"
	ModelActionRun       Model = "ActionRun"
	ModelActionRunJob    Model = "ActionRunJob"
	ModelNotification    Model = "Notification"
	ModelStopwatch       Model = "Stopwatch"
	ModelIssueWatch      Model = "IssueWatch"
	ModelWatch           Model = "Watch"
	ModelStar            Model = "Star"
	ModelBlockedUser     Model = "BlockedUser"
	ModelComment         Model = "Comment"
	ModelReaction        Model = "Reaction"
	ModelReview          Model = "Review"
	ModelReviewState     Model = "ReviewState"
	ModelAttachment      Model = "Attachment"
	ModelIssueDependency Model = "IssueDependency"
	ModelTrackedTime     Model = "TrackedTime"
	ModelContentHistory  Model = "ContentHistory"
)

// Per-model schema versions, written to livesync_log.schema_ver. Bump a
// model's version whenever its DTO changes incompatibly (a field removed,
// renamed or re-typed, or a field added that clients must not miss); clients
// drop and re-bootstrap only that model on a mismatch (PLAN §5.3).

const (
	SchemaRepository      = 1
	SchemaUser            = 1
	SchemaOrgUser         = 1
	SchemaTeam            = 1
	SchemaTeamUser        = 1
	SchemaTeamRepo        = 1
	SchemaTeamUnit        = 1
	SchemaCollaboration   = 1
	SchemaAccess          = 1
	SchemaRepoUnit        = 1
	SchemaLabel           = 1
	SchemaMilestone       = 1
	SchemaProject         = 1
	SchemaProjectColumn   = 1
	SchemaProjectIssue    = 1
	SchemaIssue           = 1
	SchemaIssueBody       = 1
	SchemaIssueLabel      = 1
	SchemaIssueAssignee   = 1
	SchemaPullRequest     = 1
	SchemaAutoMerge       = 1
	SchemaBranch          = 1
	SchemaRelease         = 1
	SchemaCommitStatus    = 1
	SchemaActionRun       = 1
	SchemaActionRunJob    = 1
	SchemaNotification    = 1
	SchemaStopwatch       = 1
	SchemaIssueWatch      = 1
	SchemaWatch           = 1
	SchemaStar            = 1
	SchemaBlockedUser     = 1
	SchemaComment         = 1
	SchemaReaction        = 1
	SchemaReview          = 1
	SchemaReviewState     = 1
	SchemaAttachment      = 1
	SchemaIssueDependency = 1
	SchemaTrackedTime     = 1
	SchemaContentHistory  = 1
)

// Op is the operation of a sync log entry (livesync_log.op, the "op" of a
// delta change).
type Op string

const (
	// OpUpsert: the payload is the entity's full current state. Applying it
	// is idempotent (clients keep it only if its sync id is newer).
	OpUpsert Op = "U"
	// OpDelete: the entity is gone from the group (deleted, or moved to
	// another group, which gets an OpUpsert). No payload.
	OpDelete Op = "D"
	// OpRebootstrap: changes to the model may have been lost (a capture
	// trigger was missing or stale, see RebootstrapMarker). Clients holding
	// entities of the model must re-bootstrap the groups they hold. Written
	// to GroupAll with entity id 0.
	OpRebootstrap Op = "B"
)

// RebootstrapMarker is the payload of an OpRebootstrap entry.
type RebootstrapMarker struct {
	// Table whose capture trigger was (re)installed.
	Table string `json:"table"`
	// Epoch is the table's schema epoch after the repair.
	Epoch int64 `json:"epoch"`
}

// Group prefixes. A sync group is "<prefix>:<id>"; every entity belongs to
// exactly one group, and clients are granted groups (PLAN §4.4, §4.5).

const (
	GroupPrefixUser  = "user"
	GroupPrefixOrg   = "org"
	GroupPrefixRepo  = "repo"
	GroupPrefixIssue = "issue"
)

// GroupAll is the pseudo group of entries that concern every client: schema
// epoch markers (OpRebootstrap) and deletes whose group is unknown (rows that
// were never materialized while the entity index was still being backfilled).
// Readers of a group always receive GroupAll entries too.
const GroupAll = "*"

// UserGroup is the group of a user's own (viewer-specific) entities.
func UserGroup(id int64) string { return GroupPrefixUser + ":" + strconv.FormatInt(id, 10) }

// OrgGroup is the group of an organization's entities.
func OrgGroup(id int64) string { return GroupPrefixOrg + ":" + strconv.FormatInt(id, 10) }

// RepoGroup is the group of a repository's summary-tier entities.
func RepoGroup(id int64) string { return GroupPrefixRepo + ":" + strconv.FormatInt(id, 10) }

// IssueGroup is the group of an issue's (or pull request's) lazy-tier
// entities: timeline, reactions, reviews, body.
func IssueGroup(id int64) string { return GroupPrefixIssue + ":" + strconv.FormatInt(id, 10) }

// Unit is the repository unit a reader needs (livesync_log.unit) to receive
// an entity of a repo:{id} or issue:{id} group, checked with
// Permission.CanRead(unit) (PLAN §4.4). UnitNone means any read access to
// the group. Several alternatives are separated by "|": the entity is visible
// with any of them. The same names identify unit types in RepoUnit/TeamUnit.
type Unit string

const (
	UnitNone            Unit = ""
	UnitCode            Unit = "code"
	UnitIssues          Unit = "issues"
	UnitPulls           Unit = "pulls"
	UnitIssuesOrPulls   Unit = "issues|pulls"
	UnitReleases        Unit = "releases"
	UnitWiki            Unit = "wiki"
	UnitExternalWiki    Unit = "ext_wiki"
	UnitExternalTracker Unit = "ext_issues"
	UnitProjects        Unit = "projects"
	UnitPackages        Unit = "packages"
	UnitActions         Unit = "actions"
)
