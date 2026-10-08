// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Package perm decides which sync groups a viewer may read, and which units
// in them (PLAN §4.5). It mirrors upstream's read checks exactly:
// repositories through access_model.GetUserRepoPermission (what API v1's
// repository routes use), organizations through
// organization.HasOrgOrUserVisible and IsOrganizationMember (API v1's org
// routes), users' profiles like API v1's GET /users/{name} (profileVisible).
//
//   - Grants: the groups granted without asking (the viewer's own user,
//     profile and owner groups, the profile directories, member
//     organizations and their owner groups, the repositories the viewer
//     owns or was given access to, and the owner groups of those whose
//     issues or pull requests the viewer may read — see owner.go). Site
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
	"strings"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	org_model "forgejo.org/models/organization"
	perm_model "forgejo.org/models/perm"
	access_model "forgejo.org/models/perm/access"
	repo_model "forgejo.org/models/repo"
	unit_model "forgejo.org/models/unit"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"
)

// Grants are the groups a viewer may read without asking, with their units.
type Grants struct {
	ViewerID int64
	groups   map[string]UnitSet
	// basis: the states of the repository and user rows the grants were
	// computed from (see Basis).
	basis Basis
	// owners: the owner of every repository the grants evaluated.
	owners map[int64]int64
	// ownerRepos: for the owner:{id} groups granted through a repository
	// (the viewer may not see the owner itself, see ownerGroup), the
	// smallest such repository's id, by owner id.
	ownerRepos map[int64]int64
}

// basisFor is the part of the grants' basis that decided group: the
// viewer's row and, for a repository, its row and its owner's; for an
// organization or profile, that user's row if the grants read it. The
// other rows decided other groups, so a decision taken from cached grants
// (and a hub subscription indexed by it) is not concerned by touches of
// them.
func (g *Grants) basisFor(group string) Basis {
	b := Basis{}
	take := func(kind string, id int64) {
		if s, ok := g.basis[basisKey{kind, id}]; ok {
			b[basisKey{kind, id}] = s
		}
	}
	take(protocol.TouchUser, g.ViewerID)
	switch kind, id := parseGroup(group); kind {
	case kindRepo:
		take(protocol.TouchRepository, id)
		if owner, ok := g.owners[id]; ok {
			take(protocol.TouchUser, owner)
		}
	case kindOrg, kindProfile:
		take(protocol.TouchUser, id)
	case kindOwner:
		take(protocol.TouchUser, id)
		if r, ok := g.ownerRepos[id]; ok {
			take(protocol.TouchRepository, r)
		}
	}
	return b
}

// Units returns the viewer's units in group, if it is granted.
func (g *Grants) Units(group string) (UnitSet, bool) {
	u, ok := g.groups[group]
	return u, ok
}

// decision returns the decision of a granted group taken from the grants.
func (g *Grants) decision(group string) (Decision, bool) {
	units, ok := g.groups[group]
	if !ok {
		return Decision{}, false
	}
	d := Decision{Units: units, Basis: g.basisFor(group)}
	switch kind, id := parseGroup(group); kind {
	case kindRepo:
		d.RepoID = id
	case kindOwner:
		d.RepoID = g.ownerRepos[id]
	}
	return d, true
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
	// Basis are the states of the repository and user rows the decision
	// was computed from: the hub re-checks a subscription when
	// Basis.Stale(epoch.Touched). Read-only. A decision taken from cached
	// grants has the part of their basis that decided the group
	// (Grants.basisFor), not all of it.
	Basis Basis
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
	kindOwner
	kindRepo
	kindIssue
)

// parseGroup splits a group name into its kind and id (0 for the profile
// directories), with protocol.ParseGroup. Pseudo groups (GroupAll,
// GroupPermission) and malformed names are kindInvalid: never granted.
func parseGroup(group string) (groupKind, int64) {
	prefix, id, ok := protocol.ParseGroup(group)
	if !ok {
		return kindInvalid, 0
	}
	switch prefix {
	case protocol.GroupPrefixProfiles:
		if group == protocol.GroupProfilesPublic {
			return kindProfilesPublic, 0
		}
		return kindProfilesLimited, 0
	case protocol.GroupPrefixUser:
		return kindUser, id
	case protocol.GroupPrefixProfile:
		return kindProfile, id
	case protocol.GroupPrefixOrg:
		return kindOrg, id
	case protocol.GroupPrefixOwner:
		return kindOwner, id
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

// compute builds the grants of viewer (nil or not usable: nothing). The
// repositories are decided like access_model.GetUserRepoPermission decides
// them (repoPermission), from inputs read with a fixed number of queries
// (viewerInputs), not ≈ 5 queries per repository.
func compute(ctx context.Context, viewer *user_model.User, viewerID int64) (*Grants, error) {
	g := &Grants{
		ViewerID: viewerID, groups: map[string]UnitSet{}, basis: Basis{}, owners: map[int64]int64{},
		ownerRepos: map[int64]int64{},
	}
	g.basis.addUser(viewer)
	if !usable(viewer) {
		return g, nil
	}
	g.groups[protocol.UserGroup(viewer.ID)] = unitBase | unitSelf
	g.groups[protocol.ProfileGroup(viewer.ID)] = unitBase
	g.groups[protocol.OwnerGroup(viewer.ID)] = unitBase
	g.groups[protocol.GroupProfilesPublic] = unitBase
	if !viewer.IsRestricted {
		g.groups[protocol.GroupProfilesLimited] = unitBase
	}

	in, err := loadViewerInputs(ctx, viewer.ID)
	if err != nil {
		return nil, err
	}
	for id := range in.orgs {
		g.groups[protocol.OrgGroup(id)] = unitBase | unitMembers
		g.groups[protocol.OwnerGroup(id)] = unitBase
	}
	repoIDs, err := in.relatedRepos(ctx, viewer.ID)
	if err != nil {
		return nil, err
	}
	e := db.GetEngine(ctx)
	for start := 0; start < len(repoIDs); start += inChunk {
		chunk := repoIDs[start:min(start+inChunk, len(repoIDs))]
		var repos []*repo_model.Repository
		if err := e.In("id", chunk).Find(&repos); err != nil {
			return nil, fmt.Errorf("livesync: grants: repositories: %w", err)
		}
		if err := loadOwners(ctx, repos); err != nil {
			return nil, err
		}
		units, err := loadRepoUnits(ctx, chunk)
		if err != nil {
			return nil, err
		}
		for _, repo := range repos {
			g.basis.addRepo(repo)
			g.owners[repo.ID] = repo.OwnerID
			if repo.Owner == nil {
				continue // GetUserRepoPermission fails on such a repository: no grant
			}
			g.basis.addUser(repo.Owner)
			p := in.repoPermission(viewer, repo, units[repo.ID])
			if p.HasAccess() {
				units := repoUnits(&p)
				g.groups[protocol.RepoGroup(repo.ID)] = units
				if units&ownerUnits != 0 {
					g.addOwner(ctx, viewer, repo, in.orgs[repo.OwnerID])
				}
			}
		}
	}
	return g, nil
}

// addOwner grants the owner:{id} group of repo's owner, whose issues or
// pull requests the viewer may read (see ownerGroup): through the
// repository with the smallest id when the viewer may not see the owner.
// member: the viewer is a member of the owner.
func (g *Grants) addOwner(ctx context.Context, viewer *user_model.User, repo *repo_model.Repository, member bool) {
	group := protocol.OwnerGroup(repo.OwnerID)
	if _, ok := g.groups[group]; ok {
		if r, via := g.ownerRepos[repo.OwnerID]; via && repo.ID < r {
			g.ownerRepos[repo.OwnerID] = repo.ID
		}
		return
	}
	g.groups[group] = unitBase
	if !ownerVisible(ctx, repo.Owner, viewer, member) {
		g.ownerRepos[repo.OwnerID] = repo.ID
	}
}

// inChunk bounds the ids of one IN (...) list.
const inChunk = 500

// viewerInputs are the rows that decide a viewer's repository permissions
// besides the repositories themselves: memberships, collaborations, access
// rows and teams.
type viewerInputs struct {
	orgs   map[int64]bool                  // organizations the viewer is a member of
	collab map[int64]bool                  // repositories the viewer collaborates on
	access map[int64]perm_model.AccessMode // access rows, by repository
	teams  map[int64]*org_model.Team       // the viewer's teams, by id
	// teamRepos are the viewer's teams per repository (team_repo rows).
	teamRepos map[int64][]*org_model.Team
	// teamUnits are the units of the viewer's teams, by team id.
	teamUnits map[int64][]*org_model.TeamUnit
}

func loadViewerInputs(ctx context.Context, viewerID int64) (*viewerInputs, error) {
	e := db.GetEngine(ctx)
	in := &viewerInputs{
		orgs: map[int64]bool{}, collab: map[int64]bool{}, access: map[int64]perm_model.AccessMode{},
		teams: map[int64]*org_model.Team{}, teamRepos: map[int64][]*org_model.Team{}, teamUnits: map[int64][]*org_model.TeamUnit{},
	}
	var orgIDs []int64
	if err := e.Table("org_user").Cols("org_id").Where("uid = ?", viewerID).Find(&orgIDs); err != nil {
		return nil, fmt.Errorf("livesync: grants: organizations: %w", err)
	}
	for _, id := range orgIDs {
		in.orgs[id] = true
	}
	var collabs []*repo_model.Collaboration
	if err := e.Where("user_id = ?", viewerID).Find(&collabs); err != nil {
		return nil, fmt.Errorf("livesync: grants: collaborations: %w", err)
	}
	for _, c := range collabs {
		in.collab[c.RepoID] = true
	}
	var accesses []*access_model.Access
	if err := e.Where("user_id = ?", viewerID).Find(&accesses); err != nil {
		return nil, fmt.Errorf("livesync: grants: access: %w", err)
	}
	for _, a := range accesses {
		in.access[a.RepoID] = a.Mode
	}
	var teams []*org_model.Team
	if err := e.Table("team").Join("INNER", "team_user", "team_user.team_id = team.id").Where("team_user.uid = ?", viewerID).Find(&teams); err != nil {
		return nil, fmt.Errorf("livesync: grants: teams: %w", err)
	}
	teamIDs := make([]int64, 0, len(teams))
	for _, t := range teams {
		if in.teams[t.ID] == nil {
			in.teams[t.ID] = t
			teamIDs = append(teamIDs, t.ID)
		}
	}
	for start := 0; start < len(teamIDs); start += inChunk {
		chunk := teamIDs[start:min(start+inChunk, len(teamIDs))]
		var teamRepos []*org_model.TeamRepo
		if err := e.In("team_id", chunk).Find(&teamRepos); err != nil {
			return nil, fmt.Errorf("livesync: grants: team repositories: %w", err)
		}
		for _, tr := range teamRepos {
			in.teamRepos[tr.RepoID] = append(in.teamRepos[tr.RepoID], in.teams[tr.TeamID])
		}
		var units []*org_model.TeamUnit
		if err := e.In("team_id", chunk).OrderBy("id").Find(&units); err != nil {
			return nil, fmt.Errorf("livesync: grants: team units: %w", err)
		}
		for _, u := range units {
			in.teamUnits[u.TeamID] = append(in.teamUnits[u.TeamID], u)
		}
	}
	return in, nil
}

// relatedRepos returns the ids of the repositories viewerID owns,
// collaborates on, has an access row for, or reaches through a team
// (sorted, deduplicated). Whether each is readable is decided by
// repoPermission; public repositories reached otherwise are checked on
// demand.
func (in *viewerInputs) relatedRepos(ctx context.Context, viewerID int64) ([]int64, error) {
	e := db.GetEngine(ctx)
	var ids []int64
	if err := e.Table("repository").Cols("id").Where("owner_id = ?", viewerID).Find(&ids); err != nil {
		return nil, fmt.Errorf("livesync: grants: owned: %w", err)
	}
	for id := range in.collab {
		ids = append(ids, id)
	}
	for id := range in.access {
		ids = append(ids, id)
	}
	for id := range in.teamRepos {
		ids = append(ids, id)
	}
	// Teams with access to all of their organization's repositories.
	var allOrgs []int64
	for _, t := range in.teams {
		if t.IncludesAllRepositories {
			allOrgs = append(allOrgs, t.OrgID)
		}
	}
	for start := 0; start < len(allOrgs); start += inChunk {
		var more []int64
		if err := e.Table("repository").Cols("id").In("owner_id", allOrgs[start:min(start+inChunk, len(allOrgs))]).Find(&more); err != nil {
			return nil, fmt.Errorf("livesync: grants: all-repository teams: %w", err)
		}
		ids = append(ids, more...)
	}
	slices.Sort(ids)
	return slices.Compact(ids), nil
}

// loadRepoUnits returns the units of the repositories, without globally
// disabled ones (as repo_model.Repository.LoadUnits).
func loadRepoUnits(ctx context.Context, repoIDs []int64) (map[int64][]*repo_model.RepoUnit, error) {
	var units []*repo_model.RepoUnit
	if err := db.GetEngine(ctx).In("repo_id", repoIDs).OrderBy("id").Find(&units); err != nil {
		return nil, fmt.Errorf("livesync: grants: repository units: %w", err)
	}
	res := make(map[int64][]*repo_model.RepoUnit, len(repoIDs))
	for _, u := range units {
		if !u.Type.UnitGlobalDisabled() {
			res[u.RepoID] = append(res[u.RepoID], u)
		}
	}
	return res, nil
}

// repoPermission is access_model.GetUserRepoPermission(repo, viewer) for a
// signed-in viewer, computed from in instead of per-repository queries:
// the same steps in the same order (repo.Owner must be loaded, units are
// the repository's units). TestGrantsMatchUpstream compares the two for
// every fixture user and repository; keep them in step when upstream's
// changes (SURFACE.md).
func (in *viewerInputs) repoPermission(viewer *user_model.User, repo *repo_model.Repository, units []*repo_model.RepoUnit) access_model.Permission {
	var p access_model.Permission
	isCollaborator := in.collab[repo.ID]
	// organization.HasOrgOrUserVisible for a signed-in viewer.
	visible := viewer.IsAdmin || repo.Owner.ID == viewer.ID ||
		!((repo.Owner.Visibility == structs.VisibleTypePrivate || viewer.IsRestricted) && !in.orgs[repo.Owner.ID])
	if !visible && !isCollaborator {
		return p
	}
	if units == nil {
		units = []*repo_model.RepoUnit{}
	}
	p.Units = units
	if viewer.IsAdmin || viewer.ID == repo.OwnerID {
		p.AccessMode = perm_model.AccessModeOwner
		return p
	}
	// access_model.accessLevel (the owner case is above).
	p.AccessMode = perm_model.AccessModeNone
	if !viewer.IsRestricted && !repo.IsPrivate {
		p.AccessMode = perm_model.AccessModeRead
	}
	if mode, ok := in.access[repo.ID]; ok {
		p.AccessMode = mode
	}
	if !repo.Owner.IsOrganization() {
		if !repo.IsPrivate && !viewer.IsRestricted && len(units) > 0 {
			p.UnitsMode = make(map[unit_model.Type]perm_model.AccessMode)
			for _, u := range units {
				if _, ok := p.UnitsMode[u.Type]; !ok {
					p.UnitsMode[u.Type] = u.DefaultPermissions.ToAccessMode(p.AccessMode)
				}
			}
		}
		return p
	}
	p.UnitsMode = make(map[unit_model.Type]perm_model.AccessMode)
	if isCollaborator {
		for _, u := range units {
			p.UnitsMode[u.Type] = p.AccessMode
		}
	}
	// organization.GetUserRepoTeams: the viewer's teams of the owner with
	// a team_repo row for the repository.
	var teams []*org_model.Team
	for _, t := range in.teamRepos[repo.ID] {
		if t.OrgID == repo.OwnerID {
			teams = append(teams, t)
		}
	}
	for _, t := range teams {
		if t.AccessMode >= perm_model.AccessModeAdmin {
			p.AccessMode = t.AccessMode
			p.UnitsMode = nil
			return p
		}
	}
	for _, u := range units {
		found := false
		for _, t := range teams {
			if teamMode := in.teamUnitMode(t.ID, u.Type); teamMode > perm_model.AccessModeNone {
				if p.UnitsMode[u.Type] < teamMode {
					p.UnitsMode[u.Type] = teamMode
				}
				found = true
			}
		}
		if !found && !repo.IsPrivate && !viewer.IsRestricted {
			if _, ok := p.UnitsMode[u.Type]; !ok {
				p.UnitsMode[u.Type] = u.DefaultPermissions.ToAccessMode(perm_model.AccessModeRead)
			}
		}
	}
	p.Units = make([]*repo_model.RepoUnit, 0, len(units))
	for t := range p.UnitsMode {
		for _, u := range units {
			if u.Type == t {
				p.Units = append(p.Units, u)
			}
		}
	}
	return p
}

// teamUnitMode is organization.Team.UnitAccessMode.
func (in *viewerInputs) teamUnitMode(teamID int64, t unit_model.Type) perm_model.AccessMode {
	for _, u := range in.teamUnits[teamID] {
		if u.Type == t {
			return u.AccessMode
		}
	}
	return perm_model.AccessModeNone
}

// loadOwners sets the Owner of each repository with one query per batch.
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
	d, ok, err = checkGroup(ctx, viewer, group)
	if d.Basis == nil {
		d.Basis = Basis{}
	}
	d.Basis.addUser(viewer)
	return d, ok, err
}

// checkGroup is check for a usable viewer; the decision's basis has the
// rows it read besides the viewer's.
func checkGroup(ctx context.Context, viewer *user_model.User, group string) (d Decision, ok bool, err error) {
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
		basis := Basis{}
		basis.addUser(&u)
		return Decision{Units: unitBase, Basis: basis}, profileVisible(ctx, &u, viewer), nil
	case kindOrg:
		return checkOrg(ctx, viewer, id)
	case kindOwner:
		return checkOwner(ctx, viewer, id)
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
	d := Decision{Units: unitBase, Basis: Basis{}}
	d.Basis.addUser(&org)
	if !org_model.HasOrgOrUserVisible(ctx, &org, viewer) {
		return d, false, nil
	}
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
	// The owner is loaded here (GetUserRepoPermission keeps a loaded one),
	// so that the basis records the owner row the decision used.
	if err := repo.LoadOwner(ctx); err != nil {
		return Decision{}, false, fmt.Errorf("livesync: check repo:%d: %w", repo.ID, err)
	}
	d := Decision{RepoID: repo.ID, Basis: Basis{}}
	d.Basis.addRepo(repo)
	d.Basis.addUser(repo.Owner)
	p, err := access_model.GetUserRepoPermission(ctx, repo, viewer)
	if err != nil {
		return Decision{}, false, fmt.Errorf("livesync: check repo:%d: %w", repo.ID, err)
	}
	if !p.HasAccess() {
		return d, false, nil
	}
	d.Units = repoUnits(&p)
	return d, true, nil
}
