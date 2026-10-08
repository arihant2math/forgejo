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
	"strings"
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
	// OpPermission: who may read what may have changed (a permission
	// epoch, PLAN §4.5). Written to GroupPermission with entity id 0 and a
	// PermissionChange payload, before the entries of the same transaction.
	// Never sent to clients: the hub recomputes the grants of the affected
	// viewers and re-checks the affected groups' subscribers.
	OpPermission Op = "P"
)

// RebootstrapMarker is the payload of an OpRebootstrap entry.
type RebootstrapMarker struct {
	// Table whose entities must be re-bootstrapped.
	Table string `json:"table"`
	// Epoch is the table's schema epoch after the repair.
	Epoch int64 `json:"epoch"`
	// Reason says why: RebootstrapTriggerRepaired (changes may have been
	// lost) or RebootstrapPlacementChanged (a new livesync version places
	// the table's entities in other groups or units).
	Reason string `json:"reason"`
}

// Reasons of a RebootstrapMarker.

const (
	RebootstrapTriggerRepaired  = "trigger_repaired"
	RebootstrapPlacementChanged = "placement_changed"
)

// PermissionChange is the payload of an OpPermission entry: the subjects
// whose access may have changed. The hub recomputes the grants of Users,
// re-checks the subscribers of the repo:{id} groups of Repos (and of the
// issue:{id} and owner:{id} groups decided by those repositories), and the
// subscribers of the org:{id}, profile:{id} and owner:{id} groups of Owners
// (a user or organization whose visibility, or whose set of possible
// viewers, changed). All means
// everything may have changed (writes to a permission table may have been
// lost): recompute every grant and re-check every subscription.
//
// Touched are the rows of the busy permission tables (repository, user)
// that were updated without a visible change of their permission state —
// mostly counters and timestamps (an issue created, a sign-in), but the
// updates may also have changed the state and changed it back before the
// materializer read the row (a repository made public and private again).
// A grant or decision computed in between saw another state: the hub
// re-checks only the subscriptions whose decision recorded another state
// of a touched row (perm.Basis.Stale), the grant caches drop only such
// entries, so a counter update costs no recomputation.
type PermissionChange struct {
	Users   []int64           `json:"users,omitempty"`
	Repos   []int64           `json:"repos,omitempty"`
	Owners  []int64           `json:"owners,omitempty"`
	All     bool              `json:"all,omitempty"`
	Touched []PermissionTouch `json:"touched,omitempty"`
}

// PermissionTouch is a row of a busy permission table that was updated
// without a visible change of its permission state (PermissionChange.Touched).
type PermissionTouch struct {
	// Kind is the row's table: TouchRepository or TouchUser.
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
	// State is the fingerprint of the row's permission state after the
	// updates (perm.RepositoryState, perm.UserState).
	State string `json:"state"`
}

// Kinds of a PermissionTouch.

const (
	TouchRepository = "repository"
	TouchUser       = "user"
)

// Group prefixes. A sync group is "<prefix>:<id>"; every entity belongs to
// exactly one group, and clients are granted groups (PLAN §4.4, §4.5).

const (
	GroupPrefixUser     = "user"
	GroupPrefixOrg      = "org"
	GroupPrefixRepo     = "repo"
	GroupPrefixIssue    = "issue"
	GroupPrefixProfile  = "profile"
	GroupPrefixProfiles = "profiles"
	GroupPrefixOwner    = "owner"
)

// The shared profile directories: the User entities (profiles) of all
// individual users with visibility public (GroupProfilesPublic, readable by
// every signed-in viewer) or limited (GroupProfilesLimited, readable by
// every signed-in viewer who is not restricted), so that a client gets the
// names and avatars of the people it shows with one subscription and one
// bootstrap each. A private user's profile is in their ProfileGroup
// instead. Organizations' profiles are in their OrgGroup.

const (
	GroupProfilesPublic  = GroupPrefixProfiles + ":public"
	GroupProfilesLimited = GroupPrefixProfiles + ":limited"
)

// GroupAll is the pseudo group of the entries that concern every client: the
// schema epoch markers (OpRebootstrap), which carry no entity data. Readers
// of a group always receive GroupAll entries too. Nothing else is written to
// it (PLAN §4.5: nothing is broadcast instance-wide).
const GroupAll = "*"

// GroupPermission is the pseudo group of the permission epochs
// (OpPermission). No client is ever granted it and no group's readers
// receive it; the hub reads it from the tailer.
const GroupPermission = "!perm"

// UserGroup is the group of a user's own, viewer-specific entities
// (subscriptions, notifications, stopwatches, stars, blocks, viewed files,
// pending reviews, access rows, …; unit UnitSelf). Only that user is
// ever granted it: what others may see of a user is in the profile groups.
func UserGroup(id int64) string { return GroupPrefixUser + ":" + strconv.FormatInt(id, 10) }

// ProfileGroup is the group of what anyone who may see individual user
// {id} reads (as API v1's GET /users/{name} decides: a private user is seen
// by themselves and site administrators only, a limited one by signed-in
// viewers who are not restricted): the columns of the projects the user
// owns and, for a private user, the User entity itself (a public or limited
// user's is in GroupProfilesPublic / GroupProfilesLimited). The projects
// themselves are in the user's OwnerGroup.
func ProfileGroup(id int64) string { return GroupPrefixProfile + ":" + strconv.FormatInt(id, 10) }

// OrgGroup is the group of an organization: what anyone who may see the
// organization reads (unit UnitNone: profile, the columns of its projects,
// public memberships) and what only its members read (unit UnitMembers:
// teams, their members, repositories and units, concealed memberships). Its
// labels and projects are in its OwnerGroup.
func OrgGroup(id int64) string { return GroupPrefixOrg + ":" + strconv.FormatInt(id, 10) }

// OwnerGroup is the group of what a user or organization {id} shares with
// its repositories: the organization's labels (IssueLabel.label_id of its
// repositories' issues may name them) and the projects the user or
// organization owns (ProjectIssue.project_id). Upstream shows them to
// everyone who may see the owner and to every reader of the issues or pull
// requests of one of the owner's repositories (the repository's label list
// and issue list pages) — e.g. an outside collaborator of a private
// organization's repository, who may not see the organization itself. So it
// is readable by the readers of the owner's OrgGroup or ProfileGroup and by
// those of the issues or pull requests of any of its repositories (unit
// UnitNone throughout). The projects' columns stay in the OrgGroup /
// ProfileGroup, which upstream shows only to those who may see the owner.
func OwnerGroup(id int64) string { return GroupPrefixOwner + ":" + strconv.FormatInt(id, 10) }

// RepoGroup is the group of a repository's summary-tier entities.
func RepoGroup(id int64) string { return GroupPrefixRepo + ":" + strconv.FormatInt(id, 10) }

// IssueGroup is the group of an issue's (or pull request's) lazy-tier
// entities: timeline, reactions, reviews, body.
func IssueGroup(id int64) string { return GroupPrefixIssue + ":" + strconv.FormatInt(id, 10) }

// ParseGroup splits a client group name into its prefix (GroupPrefix*) and
// id; the profile directories have id 0. ok is false for pseudo groups and
// malformed names (an id must be positive and canonical: no sign, no
// leading zero). It is the one parser of group names: permission checks,
// the hub and bootstraps all use it.
func ParseGroup(group string) (prefix string, id int64, ok bool) {
	switch group {
	case GroupProfilesPublic, GroupProfilesLimited:
		return GroupPrefixProfiles, 0, true
	}
	prefix, rest, found := strings.Cut(group, ":")
	if !found {
		return "", 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != rest {
		return "", 0, false
	}
	switch prefix {
	case GroupPrefixUser, GroupPrefixProfile, GroupPrefixOrg, GroupPrefixOwner, GroupPrefixRepo, GroupPrefixIssue:
		return prefix, id, true
	}
	return "", 0, false
}

// Unit is what a reader of a group needs (livesync_log.unit) to receive an
// entity of it. In repo:{id} and issue:{id} groups it is a repository unit,
// checked with Permission.CanRead(unit) (PLAN §4.4); several alternatives are
// separated by "|" (the entity is visible with any of them), and the same
// names identify unit types in RepoUnit/TeamUnit. In user:{id} groups it is
// UnitSelf (that user only; nobody else is granted the group anyway); in
// org:{id} groups UnitNone (anyone who may see the organization) or
// UnitMembers (its members only); in the profile and owner groups UnitNone.
// UnitNone means any read access to the group.
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
	// UnitSelf: in user:{id}, only that user.
	UnitSelf Unit = "self"
	// UnitMembers: in org:{id}, only the organization's members.
	UnitMembers Unit = "members"
)

// Grant is a group a viewer may read and the units they may read in it
// (UnitNone entries of the group are readable whenever it is granted).
type Grant struct {
	Group string `json:"group"`
	Units []Unit `json:"units"`
}

// Grants is the answer of GET /-/sync/grants: the groups granted to the
// viewer without asking (their own user group and profile group, the
// profile directories, the organizations they are a member of, the
// repositories they own or were given access to, and the owner groups of
// themselves, of those organizations and of the owners of those
// repositories whose issues or pull requests they may read). Other groups
// (public repositories and organizations, other users' profiles, issues) are
// checked on demand (GET /-/sync/grants?group=…, which answers one Grant).
// Site administrators get no implicit groups.
type Grants struct {
	ViewerID int64   `json:"viewer_id"`
	Grants   []Grant `json:"grants"`
}
