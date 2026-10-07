// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package protocol

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
// Replacement. Once the end line arrived, a full or summary response
// replaces what the client holds of the group within the response's scope
// (only the header's Models when it lists some): drop every entity of the
// group in the scope with v at or below the watermark that the response did
// not contain. Decide on the entities as held after applying the response's
// lines (an entity changed by a delta newer than the watermark is kept as
// the delta left it). When an Issue is dropped (here, by a closed page or by
// a delete), drop its issue:{id} group as well (unsubscribe it). The scope
// is everything in the group except what the response's tier leaves out
// and cannot send again:
//
//   - summary (repo:{id}): the closed tier — an Issue held as closed (state
//     "closed") with updated_at before ClosedBefore, and what hangs off it:
//     its IssueLabel, IssueAssignee, ProjectIssue and PullRequest entities
//     (issue_id) and the AutoMerge of such a PullRequest (pull_id); and the
//     CommitStatus, ActionRun and ActionRunJob entities with updated_at
//     before ClosedBefore (no response sends them again; they stay as the
//     deltas left them);
//   - user:{id} (ClosedBefore is set too): the Notifications held as read
//     with updated_at before ClosedBefore.
//
// Those kept entities are as of the response or delta that brought them: if
// the client missed deltas (it re-bootstraps after bootstrap_required) they
// may be stale until the closed pages that hold them are loaded again. And
// when the header's Units differ from the units the client held the group
// with (a re-bootstrap after permission_changed, see the units rule below),
// the scope is the whole group: drop the closed tier too.
//
// A closed page (TierClosed) replaces the closed tier between its cursors:
// the Issues held as closed with updated_at before the summary's
// ClosedBefore whose (updated_at in Unix seconds, id) is below the page's
// Before and at or above BootstrapEnd.Next (any, when the page has no
// Next), with what hangs off them, and what hangs off the page's own
// Issues: drop those with v at or below the page's watermark that the page
// did not contain. Pages cover the closed tier without gaps or overlaps
// (each page starts at the previous one's Next), newest first.
//
// Lines of other groups (the profiles of BootstrapEnd.Refs) only add
// entities: they are not a bootstrap of those groups, replace nothing there,
// and do not set or raise those groups' positions (see BootstrapEnd.Refs).
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
	// ClosedBefore is the recency cutoff, in Unix seconds, of a summary
	// (repo:{id}) or a user:{id} bootstrap: closed issues and pull requests,
	// commit statuses, action runs and jobs (summary) and read notifications
	// (user:{id}) not updated since are not in the response, and its
	// replacement leaves them alone. Load the closed tier with
	// /-/sync/load?group=repo:{id}&closedBefore=<this>.
	ClosedBefore *int64 `json:"closed_before,omitempty"`
	// Before (closed tier) is the closedBefore cursor the page starts at
	// (exclusive; "<unix>" or "<unix>.<id>"): the page holds the closed
	// issues and pull requests ordered (updated_at, id) below it, down to
	// BootstrapEnd.Next (included) or the oldest.
	Before string `json:"before,omitempty"`
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
	// in this response (after the group's own entities, v = the watermark);
	// those of the directories were not. Such a line only adds the one
	// entity: it is not a bootstrap of its group (an organization's group
	// also holds its labels, projects, teams and members, which issues of
	// its repositories refer to), and it does not set or raise that group's
	// position. To hold a referenced group, bootstrap it, then subscribe it
	// with since = that bootstrap's watermark — never with this response's
	// watermark, which would skip the group's entities the client never got.
	// The workspace lists the groups to hold (the directories, the viewer's
	// organizations and those owning the workspace's repositories).
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
	Reason string `json:"reason" tstype:"'self' | 'profile' | 'directory' | 'member' | 'repo_owner' | 'owner' | 'access' | 'watch'"`
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
	// WorkspaceRepoOwner: an organization the viewer is not a member of
	// that owns a repository of the workspace and that the viewer may see.
	// Its group holds what the repository's entities refer to besides
	// themselves: the organization's labels (IssueLabel.label_id), projects
	// and columns (ProjectIssue), public members and teams the viewer may
	// see.
	WorkspaceRepoOwner = "repo_owner"
	// WorkspaceOwner: a repository the viewer owns.
	WorkspaceOwner = "owner"
	// WorkspaceAccess: a repository the viewer was given access to
	// (collaboration, team, organization ownership).
	WorkspaceAccess = "access"
	// WorkspaceWatch: a repository the viewer watches (and may read).
	WorkspaceWatch = "watch"
)
