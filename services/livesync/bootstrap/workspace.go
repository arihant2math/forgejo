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
// groups, the profile directories, member organizations), then the
// repositories they own, were given access to (the implicit grants) or
// watch and may read, most recently updated first, at most maxRepos.
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
	n := 0
	for _, r := range repos {
		if n == maxRepos {
			ws.Truncated = true
			break
		}
		group := protocol.RepoGroup(r.ID)
		if units, ok := implicit[r.ID]; ok {
			reason := protocol.WorkspaceAccess
			if r.OwnerID == viewerID {
				reason = protocol.WorkspaceOwner
			}
			ws.Groups = append(ws.Groups, protocol.WorkspaceGroup{Group: group, Units: units, Reason: reason})
			n++
			continue
		}
		// Watched without an implicit grant: a public repository, or one
		// the viewer has lost access to.
		d, ok, err := perms.Check(ctx, viewerID, group)
		if err != nil {
			return nil, err
		}
		if ok {
			ws.Groups = append(ws.Groups, protocol.WorkspaceGroup{Group: group, Units: d.Units.Units(), Reason: protocol.WorkspaceWatch})
			n++
		}
	}
	return ws, nil
}
