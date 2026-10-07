// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

import (
	"strconv"
	"strings"
)

// Tiers of a bootstrap (BootstrapHeader.Tier).

const (
	// TierFull: every entity of the group (every group but repo:{id}, and
	// issue:{id} also through /-/sync/load).
	TierFull = "full"
	// TierSummary: a repo:{id} group's summary tier: open issues and pull
	// requests plus those updated since BootstrapHeader.ClosedBefore, with
	// their labels, assignees, pull requests and project cards; commit
	// statuses and action runs updated since then; and every other entity of
	// the group (repository, units, labels, milestones, projects, branches,
	// releases, collaborations).
	TierSummary = "summary"
	// TierClosed: a page of a repo:{id} group's older closed issues and pull
	// requests (closed, not updated since the summary's cutoff), newest
	// first, with their labels, assignees, pull requests and project cards
	// (GET /-/sync/load?group=repo:{id}&closedBefore=…).
	TierClosed = "closed"
)

// BootstrapHeader is the first line of a bootstrap or load response.
//
// Bootstraps and partial loads (PLAN §4.7): GET /-/sync/bootstrap?group=…
// and GET /-/sync/load?group=… stream NDJSON, one JSON object per line:
//
//  1. a BootstrapHeader (type "header");
//  2. the entities, each a Change with op U (exactly as a delta carries it;
//     every change's v is the header's watermark). The group's own entities
//     come first (g = the requested group); they may be followed by the
//     User entities (profiles) of other groups that the group's entities
//     refer to (see BootstrapEnd.Refs);
//  3. a BootstrapEnd (type "end"). A response without it is incomplete
//     (the server failed or the connection broke): discard it and retry.
//
// The watermark is the sync log head read before the snapshot. Subscribe the
// group with since = watermark (or keep the subscription you have): the
// stream replays everything after it, and changes apply only when their v is
// newer than what the client holds, so the overlap is harmless.
//
// A full or summary bootstrap (BootstrapHeader.Tier TierFull/TierSummary)
// replaces what the client holds of the group: once the end line arrived,
// drop every entity of the group (of the header's Models when it lists
// some) with a version at or below the watermark that the response did not
// contain. A closed page (TierClosed) only adds entities, and so do the
// profile lines of other groups (they are not a bootstrap of those groups).
//
// The response is filtered by the viewer's units in the group, which the
// header states (Units, as in a Grant): keep them with the group and treat a
// later grant with other units as bootstrap_required{permission_changed}
// (the units rule, see GroupRequest).
//
// An issue's load (issue:{id}) also carries the comments that refer to the
// issue from other repositories and that the viewer may see (upstream shows
// them only to readers of the referencing repository's issues or pull
// requests). They are decided per viewer and are not in the sync log: no
// delta changes them; the next load of the issue refreshes them.
type BootstrapHeader struct {
	Type  string `json:"type" tstype:"'header'"`
	Group string `json:"group"`
	// Watermark is the sync log head read before the snapshot was taken.
	Watermark int64 `json:"watermark"`
	// Units are the viewer's units in the group the response was filtered
	// by (canonical order, as in a Grant).
	Units []Unit `json:"units"`
	// Tier is TierFull, TierSummary or TierClosed.
	Tier string `json:"tier" tstype:"'full' | 'summary' | 'closed'"`
	// Schemas are the schema versions of the models the response may
	// contain (User included: profiles may follow the entities).
	Schemas map[Model]int `json:"schemas"`
	// Models is set when the request asked for some models only (?model=);
	// the response then replaces only those.
	Models []Model `json:"models,omitempty"`
	// ClosedBefore (summary tier) is the recency cutoff, in Unix seconds:
	// closed issues and pull requests not updated since are not in the
	// summary; load them with /-/sync/load?group=…&closedBefore=<this>.
	ClosedBefore *int64 `json:"closed_before,omitempty"`
}

// BootstrapEnd is the last line of a complete bootstrap or load response.
type BootstrapEnd struct {
	Type string `json:"type" tstype:"'end'"`
	// Count is the number of entities of the requested group sent.
	Count int `json:"count"`
	// Refs are the groups holding the User entities (profiles) that the
	// group's entities refer to (posters, assignees, owners, …) and that
	// the viewer may read: the profile directories (profiles:public,
	// profiles:limited), private users' profile:{id} and organizations'
	// org:{id}. The profiles of profile:{id} and org:{id} groups were sent
	// in this response (after the group's own entities); those of the
	// directories were not: subscribe/bootstrap the directories (the
	// workspace does). Subscribe any of them with since = watermark to keep
	// the embedded profiles current.
	Refs []string `json:"refs"`
	// Next (closed tier) is the closedBefore value of the next page; absent
	// on the last page.
	Next string `json:"next,omitempty"`
}

// Workspace answers GET /-/sync/workspace: the groups the client should keep
// subscribed and bootstrapped (available offline), PLAN §4.7: the viewer's
// own groups, the profile directories, their organizations and the
// repositories they own, were given access to or watch — the repositories
// ordered by recent activity and capped. Other groups (other public
// repositories, issues) are loaded on demand; a client may pin more itself.
type Workspace struct {
	ViewerID int64            `json:"viewer_id"`
	Groups   []WorkspaceGroup `json:"groups"`
	// Truncated says that repositories were left out because of the cap
	// (MaxRepos, [livesync] WORKSPACE_MAX_REPOS).
	Truncated bool `json:"truncated"`
	MaxRepos  int  `json:"max_repos"`
}

// WorkspaceGroup is a group of the workspace, with the viewer's units in it
// (as in a Grant) and why it is there.
type WorkspaceGroup struct {
	Group  string `json:"group"`
	Units  []Unit `json:"units"`
	Reason string `json:"reason" tstype:"'self' | 'profile' | 'directory' | 'member' | 'owner' | 'access' | 'watch'"`
}

// Reasons of a WorkspaceGroup.

const (
	// WorkspaceSelf: the viewer's own user:{id} group.
	WorkspaceSelf = "self"
	// WorkspaceProfile: the viewer's own profile:{id} group.
	WorkspaceProfile = "profile"
	// WorkspaceDirectory: a shared profile directory.
	WorkspaceDirectory = "directory"
	// WorkspaceMember: an organization the viewer is a member of.
	WorkspaceMember = "member"
	// WorkspaceOwner: a repository the viewer owns.
	WorkspaceOwner = "owner"
	// WorkspaceAccess: a repository the viewer was given access to
	// (collaboration, team, organization ownership).
	WorkspaceAccess = "access"
	// WorkspaceWatch: a repository the viewer watches (and may read).
	WorkspaceWatch = "watch"
)

// ParseGroup splits a client group name into its prefix (GroupPrefix*) and
// id; the profile directories have id 0. ok is false for pseudo groups and
// malformed names.
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
	case GroupPrefixUser, GroupPrefixProfile, GroupPrefixOrg, GroupPrefixRepo, GroupPrefixIssue:
		return prefix, id, true
	}
	return "", 0, false
}
