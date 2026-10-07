// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"context"
	"fmt"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"xorm.io/builder"
)

// CheckGroups is Check for many groups at once: it returns the decisions of
// the readable ones (the others are absent). Groups of the viewer's cached
// grants are decided from them; the others in one read transaction with a
// fixed number of queries — the user rows of the profiles and
// organizations, the viewer's memberships among those organizations, and
// per 500 repositories their rows, owners and units with the viewer's
// inputs (as Grants: repoPermission) — instead of one transaction and
// several queries per group. issue:{id} groups are checked one by one.
// The decisions are Check's (TestCheckGroups compares them for every
// fixture user and group); use it whenever a response needs more than a
// few groups decided (the profiles a bootstrap refers to, a workspace's
// watched repositories).
func (c *Cache) CheckGroups(ctx context.Context, viewerID int64, groups []string) (map[string]Decision, error) {
	res := map[string]Decision{}
	var viewer *user_model.User
	var grants *Grants
	if e := c.cached(viewerID); e != nil {
		if e.viewer == nil {
			return res, nil
		}
		viewer, grants = e.viewer, e.grants
	}
	var rest []string
	seen := map[string]bool{}
	for _, group := range groups {
		if seen[group] {
			continue
		}
		seen[group] = true
		if grants != nil {
			if units, ok := grants.Units(group); ok {
				d := Decision{Units: units, Basis: grants.basisFor(group)}
				if kind, id := parseGroup(group); kind == kindRepo {
					d.RepoID = id
				}
				res[group] = d
				continue
			}
		}
		rest = append(rest, group)
	}
	if len(rest) == 0 {
		return res, nil
	}
	err := readMaster(ctx, func(ctx context.Context) error {
		if viewer == nil {
			u, found, err := lookupUser(ctx, viewerID)
			if err != nil || !found {
				return err
			}
			viewer = &u
		}
		return checkGroups(ctx, viewer, rest, res)
	})
	return res, err
}

// checkGroups adds the decisions of the readable groups among groups to
// res (see CheckGroups).
func checkGroups(ctx context.Context, viewer *user_model.User, groups []string, res map[string]Decision) error {
	if !usable(viewer) {
		return nil
	}
	add := func(group string, d Decision) {
		if d.Basis == nil {
			d.Basis = Basis{}
		}
		d.Basis.addUser(viewer)
		res[group] = d
	}
	var profiles, orgs, repos []int64
	for _, group := range groups {
		switch kind, id := parseGroup(group); kind {
		case kindProfile:
			profiles = append(profiles, id)
		case kindOrg:
			orgs = append(orgs, id)
		case kindRepo:
			repos = append(repos, id)
		case kindInvalid:
		default: // user:, the directories (no query) and issue:
			d, ok, err := checkGroup(ctx, viewer, group)
			if err != nil {
				return err
			}
			if ok {
				add(group, d)
			}
		}
	}

	users, err := usersByID(ctx, append(profiles, orgs...))
	if err != nil {
		return err
	}
	for _, id := range profiles {
		if u := users[id]; u != nil && !u.IsOrganization() && profileVisible(ctx, u, viewer) {
			d := Decision{Units: unitBase, Basis: Basis{}}
			d.Basis.addUser(u)
			add(protocol.ProfileGroup(id), d)
		}
	}
	if len(orgs) > 0 {
		// The viewer's memberships among them (checkOrg:
		// HasOrgOrUserVisible and IsOrganizationMember read org_user).
		var memberOf []int64
		if err := db.GetEngine(ctx).Table("org_user").Cols("org_id").
			Where(builder.Eq{"uid": viewer.ID}.And(builder.In("org_id", orgs))).Find(&memberOf); err != nil {
			return fmt.Errorf("livesync: check organizations: %w", err)
		}
		member := map[int64]bool{}
		for _, id := range memberOf {
			member[id] = true
		}
		for _, id := range orgs {
			org := users[id]
			if org == nil || !org.IsOrganization() {
				continue
			}
			// organization.HasOrgOrUserVisible for a signed-in viewer.
			if !viewer.IsAdmin && org.ID != viewer.ID &&
				(org.Visibility == structs.VisibleTypePrivate || viewer.IsRestricted) && !member[id] {
				continue
			}
			d := Decision{Units: unitBase, Basis: Basis{}}
			d.Basis.addUser(org)
			if viewer.IsAdmin || member[id] {
				d.Units |= unitMembers
			}
			add(protocol.OrgGroup(id), d)
		}
	}

	if len(repos) == 0 {
		return nil
	}
	in, err := loadViewerInputs(ctx, viewer.ID)
	if err != nil {
		return err
	}
	for start := 0; start < len(repos); start += inChunk {
		chunk := repos[start:min(start+inChunk, len(repos))]
		var rows []*repo_model.Repository
		if err := db.GetEngine(ctx).In("id", chunk).Find(&rows); err != nil {
			return fmt.Errorf("livesync: check repositories: %w", err)
		}
		if err := loadOwners(ctx, rows); err != nil {
			return err
		}
		units, err := loadRepoUnits(ctx, chunk)
		if err != nil {
			return err
		}
		for _, repo := range rows {
			if repo.Owner == nil {
				continue // GetUserRepoPermission fails on such a repository: not readable
			}
			p := in.repoPermission(viewer, repo, units[repo.ID])
			if !p.HasAccess() {
				continue
			}
			d := Decision{Units: repoUnits(&p), RepoID: repo.ID, Basis: Basis{}}
			d.Basis.addRepo(repo)
			d.Basis.addUser(repo.Owner)
			add(protocol.RepoGroup(repo.ID), d)
		}
	}
	return nil
}

// usersByID reads the user rows of ids (organizations included).
func usersByID(ctx context.Context, ids []int64) (map[int64]*user_model.User, error) {
	res := make(map[int64]*user_model.User, len(ids))
	for start := 0; start < len(ids); start += inChunk {
		users, err := user_model.GetUserByIDs(ctx, ids[start:min(start+inChunk, len(ids))])
		if err != nil {
			return nil, fmt.Errorf("livesync: check users: %w", err)
		}
		for _, u := range users {
			res[u.ID] = u
		}
	}
	return res, nil
}
