// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package bootstrap

import (
	"cmp"
	"context"
	"fmt"
	"slices"

	"forgejo.org/models/db"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/services/livesync/capture"
	"forgejo.org/services/livesync/perm"
	"forgejo.org/services/livesync/protocol"

	"xorm.io/builder"
)

// Workspace returns the viewer's workspace (protocol.Workspace): the
// non-repository groups of their implicit grants (own user and profile
// groups, the profile directories, member organizations), the other
// organizations that own the listed repositories and that the viewer may
// see, then the repositories they own, were given access to (the implicit
// grants) or watch and may read, most recently updated first, at most
// maxRepos. Its cost does not grow with checks per repository: the watched
// repositories and the organizations are decided in batches.
func Workspace(ctx context.Context, perms *perm.Cache, viewerID int64, maxRepos int) (*protocol.Workspace, error) {
	grants, err := perms.Grants(ctx, viewerID)
	if err != nil {
		return nil, err
	}
	ws := &protocol.Workspace{ViewerID: viewerID, Groups: []protocol.WorkspaceGroup{}, MaxRepos: maxRepos}
	wire := grants.Wire()
	if len(wire.Grants) == 0 {
		return ws, nil // a viewer who may not sign in
	}
	implicit := map[int64][]protocol.Unit{}
	for _, g := range wire.Grants {
		prefix, id, _ := protocol.ParseGroup(g.Group)
		var reason string
		switch prefix {
		case protocol.GroupPrefixRepo:
			implicit[id] = g.Units
			continue
		case protocol.GroupPrefixUser:
			reason = protocol.WorkspaceSelf
		case protocol.GroupPrefixProfile:
			reason = protocol.WorkspaceProfile
		case protocol.GroupPrefixProfiles:
			reason = protocol.WorkspaceDirectory
		case protocol.GroupPrefixOrg:
			reason = protocol.WorkspaceMember
		default:
			continue
		}
		ws.Groups = append(ws.Groups, protocol.WorkspaceGroup{Group: g.Group, Units: g.Units, Reason: reason})
	}

	type repoRow struct {
		ID          int64 `xorm:"id"`
		OwnerID     int64 `xorm:"owner_id"`
		UpdatedUnix int64 `xorm:"updated_unix"`
	}
	var repos []repoRow
	watched := map[int64]bool{}
	err = capture.WithQuietTx(ctx, func(ctx context.Context) error {
		var watches []int64
		if err := db.GetEngine(ctx).Table("watch").Cols("repo_id").
			Where(builder.Eq{"user_id": viewerID}.And(repo_model.BuilderWatchAnything())).Find(&watches); err != nil {
			return err
		}
		ids := make([]int64, 0, len(implicit)+len(watches))
		for id := range implicit {
			ids = append(ids, id)
		}
		for _, id := range watches {
			if _, ok := implicit[id]; !ok && !watched[id] {
				watched[id] = true
				ids = append(ids, id)
			}
		}
		for start := 0; start < len(ids); start += 500 {
			var chunk []repoRow
			if err := db.GetEngine(ctx).Table("repository").Cols("id", "owner_id", "updated_unix").
				In("id", ids[start:min(start+500, len(ids))]).Find(&chunk); err != nil {
				return err
			}
			repos = append(repos, chunk...)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("livesync: workspace of user %d: %w", viewerID, err)
	}
	slices.SortFunc(repos, func(a, b repoRow) int {
		return cmp.Or(cmp.Compare(b.UpdatedUnix, a.UpdatedUnix), cmp.Compare(b.ID, a.ID))
	})
	// The watched repositories without an implicit grant (public ones, or
	// ones the viewer has lost access to), decided in one batch: the cap
	// counts readable repositories only, so they are decided before it.
	var watchedGroups []string
	for _, r := range repos {
		if watched[r.ID] {
			watchedGroups = append(watchedGroups, protocol.RepoGroup(r.ID))
		}
	}
	readable, err := perms.CheckGroups(ctx, viewerID, watchedGroups)
	if err != nil {
		return nil, err
	}
	var repoGroups []protocol.WorkspaceGroup
	owners := map[int64]bool{}
	var ownerGroups []string
	for _, r := range repos {
		group := protocol.RepoGroup(r.ID)
		g := protocol.WorkspaceGroup{Group: group, Units: implicit[r.ID], Reason: protocol.WorkspaceAccess}
		switch d, ok := readable[group]; {
		case !watched[r.ID] && r.OwnerID == viewerID:
			g.Reason = protocol.WorkspaceOwner
		case watched[r.ID] && ok:
			g.Units, g.Reason = d.Units.Units(), protocol.WorkspaceWatch
		case watched[r.ID]:
			continue
		}
		if len(repoGroups) == maxRepos {
			ws.Truncated = true
			break
		}
		repoGroups = append(repoGroups, g)
		if r.OwnerID != viewerID && !owners[r.OwnerID] {
			owners[r.OwnerID] = true
			ownerGroups = append(ownerGroups, protocol.OrgGroup(r.OwnerID))
		}
	}

	// The organizations owning those repositories that the viewer may see
	// without being a member: the repositories' issues refer to their
	// labels and projects, which live in org:{id}. (A member's are already
	// listed; an owner that is a user, or an organization the viewer may
	// not see, is refused by the check.)
	orgs, err := perms.CheckGroups(ctx, viewerID, ownerGroups)
	if err != nil {
		return nil, err
	}
	listed := map[string]bool{}
	for _, g := range ws.Groups {
		listed[g.Group] = true
	}
	for _, group := range ownerGroups {
		if d, ok := orgs[group]; ok && !listed[group] {
			ws.Groups = append(ws.Groups, protocol.WorkspaceGroup{Group: group, Units: d.Units.Units(), Reason: protocol.WorkspaceRepoOwner})
		}
	}
	ws.Groups = append(ws.Groups, repoGroups...)
	return ws, nil
}
