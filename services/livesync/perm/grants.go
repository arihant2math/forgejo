// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package perm decides which sync groups a viewer may read, and which units
// in them (PLAN §4.5). It mirrors upstream's read checks exactly:
// repositories through access_model.GetUserRepoPermission (what API v1's
// repository routes use), organizations through
// organization.HasOrgOrUserVisible and IsOrganizationMember (API v1's org
// routes), users' profiles like API v1's GET /users/{name} (profileVisible).
//
//   - Grants: the groups granted without asking (the viewer's own user and
//     profile groups, the profile directories, member organizations and the
//     repositories the viewer owns or was given access to). Site
//     administrators get no implicit groups; public repositories and
//     organizations, other users' profiles and issues are checked on demand
//     (Check), where administrators are treated as upstream treats them.
//   - Cache: grants per viewer, shared by all of the viewer's connections,
//     invalidated by the permission epochs (protocol.OpPermission entries)
//     the materializer writes when a permission-relevant row changes.
//
// A viewer who may not sign in (inactive, login prohibited, an
// organization, missing) is granted nothing.
package perm

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	org_model "forgejo.org/models/organization"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"
)

// Grants are the groups a viewer may read without asking, with their units.
type Grants struct {
	ViewerID int64
	groups   map[string]UnitSet
}

// Units returns the viewer's units in group, if it is granted.
func (g *Grants) Units(group string) (UnitSet, bool) {
	u, ok := g.groups[group]
	return u, ok
}

// Wire returns the grants as sent to clients, sorted by group.
func (g *Grants) Wire() protocol.Grants {
	res := protocol.Grants{ViewerID: g.ViewerID, Grants: make([]protocol.Grant, 0, len(g.groups))}
	for group, units := range g.groups {
		res.Grants = append(res.Grants, protocol.Grant{Group: group, Units: units.Units()})
	}
	slices.SortFunc(res.Grants, func(a, b protocol.Grant) int { return strings.Compare(a.Group, b.Group) })
	return res
}

// Decision is the answer of an on-demand check of one group.
type Decision struct {
	Units UnitSet
	// RepoID is the repository whose permission decided a repo:{id} or
	// issue:{id} group (0 for other groups): the hub re-checks such
	// subscriptions when a permission epoch names the repository.
	RepoID int64
}

// Wire returns the decision as sent to clients.
func (d Decision) Wire(group string) protocol.Grant {
	return protocol.Grant{Group: group, Units: d.Units.Units()}
}

// groupKind is the kind of a sync group name.
type groupKind int

const (
	kindInvalid groupKind = iota
	kindUser
	kindProfile
	kindProfilesPublic
	kindProfilesLimited
	kindOrg
	kindRepo
	kindIssue
)

// parseGroup splits a group name into its kind and id (0 for the profile
// directories). Pseudo groups (GroupAll, GroupPermission) and malformed
// names are kindInvalid: never granted.
func parseGroup(group string) (groupKind, int64) {
	switch group {
	case protocol.GroupProfilesPublic:
		return kindProfilesPublic, 0
	case protocol.GroupProfilesLimited:
		return kindProfilesLimited, 0
	}
	prefix, rest, ok := strings.Cut(group, ":")
	if !ok {
		return kindInvalid, 0
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != rest {
		return kindInvalid, 0
	}
	switch prefix {
	case protocol.GroupPrefixUser:
		return kindUser, id
	case protocol.GroupPrefixProfile:
		return kindProfile, id
	case protocol.GroupPrefixOrg:
		return kindOrg, id
	case protocol.GroupPrefixRepo:
		return kindRepo, id
	case protocol.GroupPrefixIssue:
		return kindIssue, id
	}
	return kindInvalid, 0
}

// usable reports whether u may sign in and so be granted anything.
func usable(u *user_model.User) bool {
	return u != nil && u.ID > 0 && u.IsActive && !u.ProhibitLogin && !u.IsOrganization()
}

// lookupUser reads a user row; ok is false when it does not exist.
func lookupUser(ctx context.Context, id int64) (u user_model.User, ok bool, err error) {
	found, err := user_model.GetUserByID(ctx, id)
	switch {
	case user_model.IsErrUserNotExist(err):
		return u, false, nil
	case err != nil:
		return u, false, fmt.Errorf("livesync: load user %d: %w", id, err)
	}
	return *found, true, nil
}

// compute builds the grants of viewer (nil or not usable: nothing).
func compute(ctx context.Context, viewer *user_model.User, viewerID int64) (*Grants, error) {
	g := &Grants{ViewerID: viewerID, groups: map[string]UnitSet{}}
	if !usable(viewer) {
		return g, nil
	}
	g.groups[protocol.UserGroup(viewer.ID)] = unitBase | unitSelf
	g.groups[protocol.ProfileGroup(viewer.ID)] = unitBase
	g.groups[protocol.GroupProfilesPublic] = unitBase
	if !viewer.IsRestricted {
		g.groups[protocol.GroupProfilesLimited] = unitBase
	}

	e := db.GetEngine(ctx)
	var orgIDs []int64
	if err := e.Table("org_user").Cols("org_id").Where("uid = ?", viewer.ID).Find(&orgIDs); err != nil {
		return nil, fmt.Errorf("livesync: grants: organizations: %w", err)
	}
	for _, id := range orgIDs {
		g.groups[protocol.OrgGroup(id)] = unitBase | unitMembers
	}

	repoIDs, err := relatedRepos(ctx, viewer.ID)
	if err != nil {
		return nil, err
	}
	for start := 0; start < len(repoIDs); start += inChunk {
		var repos []*repo_model.Repository
		if err := e.In("id", repoIDs[start:min(start+inChunk, len(repoIDs))]).Find(&repos); err != nil {
			return nil, fmt.Errorf("livesync: grants: repositories: %w", err)
		}
		if err := loadOwners(ctx, repos); err != nil {
			return nil, err
		}
		for _, repo := range repos {
			p, err := access_model.GetUserRepoPermission(ctx, repo, viewer)
			if err != nil {
				return nil, fmt.Errorf("livesync: grants: permission on repository %d: %w", repo.ID, err)
			}
			if p.HasAccess() {
				g.groups[protocol.RepoGroup(repo.ID)] = repoUnits(&p)
			}
		}
	}
	return g, nil
}

// inChunk bounds the ids of one IN (...) list.
const inChunk = 500

// relatedRepos returns the ids of the repositories viewerID owns,
// collaborates on, has an access row for, or reaches through a team
// (sorted, deduplicated). Whether each is readable is decided by
// GetUserRepoPermission; public repositories reached otherwise are checked
// on demand.
func relatedRepos(ctx context.Context, viewerID int64) ([]int64, error) {
	e := db.GetEngine(ctx)
	var ids, more []int64
	queries := []struct {
		what  string
		table string
		col   string
		cond  string
	}{
		{"owned", "repository", "id", "owner_id = ?"},
		{"collaborations", "collaboration", "repo_id", "user_id = ?"},
		{"access", "access", "repo_id", "user_id = ?"},
		{"team repositories", "team_repo", "repo_id", "team_id IN (SELECT team_id FROM team_user WHERE uid = ?)"},
		// Teams with access to all of their organization's repositories.
		{"all-repository teams", "repository", "id", "owner_id IN (SELECT team.org_id FROM team JOIN team_user ON team_user.team_id = team.id WHERE team_user.uid = ? AND team.includes_all_repositories = ?)"},
	}
	for _, q := range queries {
		more = more[:0]
		args := []any{viewerID}
		if strings.Count(q.cond, "?") == 2 {
			args = append(args, true)
		}
		if err := e.Table(q.table).Cols(q.col).Where(q.cond, args...).Find(&more); err != nil {
			return nil, fmt.Errorf("livesync: grants: %s: %w", q.what, err)
		}
		ids = append(ids, more...)
	}
	slices.Sort(ids)
	return slices.Compact(ids), nil
}

// loadOwners sets the Owner of each repository with one query per batch
// (GetUserRepoPermission would load them one by one).
func loadOwners(ctx context.Context, repos []*repo_model.Repository) error {
	ownerIDs := make([]int64, 0, len(repos))
	for _, r := range repos {
		ownerIDs = append(ownerIDs, r.OwnerID)
	}
	owners, err := user_model.GetUserByIDs(ctx, ownerIDs)
	if err != nil {
		return fmt.Errorf("livesync: grants: repository owners: %w", err)
	}
	byID := make(map[int64]*user_model.User, len(owners))
	for _, o := range owners {
		byID[o.ID] = o
	}
	for _, r := range repos {
		if o := byID[r.OwnerID]; o != nil {
			r.Owner = o
		}
	}
	return nil
}

// check decides one group for viewer on demand. ok is false when the group
// is not readable, does not exist, or is not a group clients may read.
func check(ctx context.Context, viewer *user_model.User, group string) (d Decision, ok bool, err error) {
	if !usable(viewer) {
		return d, false, nil
	}
	kind, id := parseGroup(group)
	switch kind {
	case kindUser:
		return Decision{Units: unitBase | unitSelf}, id == viewer.ID, nil
	case kindProfilesPublic:
		return Decision{Units: unitBase}, true, nil
	case kindProfilesLimited:
		return Decision{Units: unitBase}, !viewer.IsRestricted, nil
	case kindProfile:
		u, ok, err := lookupUser(ctx, id)
		if err != nil || !ok || u.IsOrganization() {
			return d, false, err
		}
		return Decision{Units: unitBase}, profileVisible(ctx, &u, viewer), nil
	case kindOrg:
		return checkOrg(ctx, viewer, id)
	case kindRepo:
		repo, err := repo_model.GetRepositoryByID(ctx, id)
		if repo_model.IsErrRepoNotExist(err) {
			return d, false, nil
		} else if err != nil {
			return d, false, fmt.Errorf("livesync: check %s: %w", group, err)
		}
		return checkRepo(ctx, viewer, repo)
	case kindIssue:
		issue, err := issues_model.GetIssueByID(ctx, id)
		if issues_model.IsErrIssueNotExist(err) {
			return d, false, nil
		} else if err != nil {
			return d, false, fmt.Errorf("livesync: check %s: %w", group, err)
		}
		repo, err := repo_model.GetRepositoryByID(ctx, issue.RepoID)
		if repo_model.IsErrRepoNotExist(err) {
			return d, false, nil
		} else if err != nil {
			return d, false, fmt.Errorf("livesync: check %s: %w", group, err)
		}
		d, ok, err := checkRepo(ctx, viewer, repo)
		if !ok || err != nil {
			return d, false, err
		}
		need := unitIssues
		if issue.IsPull {
			need = unitPulls
		}
		return d, d.Units&need != 0, nil
	}
	return d, false, nil
}

// profileVisible decides whether viewer may see individual user u's
// profile, as API v1's GET /users/{name} does: individualPermsChecker (a
// private user only to themselves and site administrators) and then
// user_model.IsUserVisibleToViewer (a limited user not to restricted
// viewers). The web profile page is more lenient for private users (it
// only applies IsUserVisibleToViewer, which also admits the users a private
// user follows and their organization co-members); livesync takes the
// stricter API rule, so follows and team co-membership never matter here.
func profileVisible(ctx context.Context, u, viewer *user_model.User) bool {
	if u.Visibility == structs.VisibleTypePrivate && u.ID != viewer.ID && !viewer.IsAdmin {
		return false
	}
	return user_model.IsUserVisibleToViewer(ctx, u, viewer)
}

func checkOrg(ctx context.Context, viewer *user_model.User, id int64) (Decision, bool, error) {
	org, ok, err := lookupUser(ctx, id)
	if err != nil || !ok || !org.IsOrganization() {
		return Decision{}, false, err
	}
	if !org_model.HasOrgOrUserVisible(ctx, &org, viewer) {
		return Decision{}, false, nil
	}
	d := Decision{Units: unitBase}
	// API v1's reqOrgMembership: members and site administrators.
	member := viewer.IsAdmin
	if !member {
		if member, err = org_model.IsOrganizationMember(ctx, id, viewer.ID); err != nil {
			return Decision{}, false, fmt.Errorf("livesync: check org:%d: %w", id, err)
		}
	}
	if member {
		d.Units |= unitMembers
	}
	return d, true, nil
}

func checkRepo(ctx context.Context, viewer *user_model.User, repo *repo_model.Repository) (Decision, bool, error) {
	p, err := access_model.GetUserRepoPermission(ctx, repo, viewer)
	if err != nil {
		return Decision{}, false, fmt.Errorf("livesync: check repo:%d: %w", repo.ID, err)
	}
	if !p.HasAccess() {
		return Decision{}, false, nil
	}
	return Decision{Units: repoUnits(&p), RepoID: repo.ID}, true, nil
}
