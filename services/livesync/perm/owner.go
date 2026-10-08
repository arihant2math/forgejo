// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package perm

import (
	"context"
	"fmt"

	"forgejo.org/models/db"
	org_model "forgejo.org/models/organization"
	repo_model "forgejo.org/models/repo"
	user_model "forgejo.org/models/user"
	"forgejo.org/modules/structs"
	"forgejo.org/services/livesync/protocol"

	"xorm.io/builder"
)

// Owner groups (protocol.OwnerGroup). An organization's labels and the
// projects a user or organization owns are what the issues of its
// repositories refer to (IssueLabel.label_id, ProjectIssue.project_id).
// Upstream shows them to everyone who may see the owner, and to every reader
// of the issues or pull requests of one of the owner's repositories: the
// repository's label page (/{owner}/{repo}/labels, reqRepoIssuesOrPullsReader)
// lists every label of the owning organization, its issue list offers every
// project of the owner as a filter, and API v1's issue JSON carries the
// labels' names and colours. Such a reader may not see the owner itself — an
// outside collaborator of a private organization's repository, a restricted
// user with access to a repository of a limited one — so these entities
// cannot live in org:{id} / profile:{id}. owner:{id} is readable:
//
//   - like the owner's own group: HasOrgOrUserVisible for an organization,
//     profileVisible for an individual (ownerVisible); or else
//   - through a repository of the owner whose issues or pull requests the
//     viewer may read (ownerUnits). Without seeing the owner, the viewer has
//     access to its repositories only as a collaborator (GetUserRepoPermission
//     refuses everybody else), so the candidates are the viewer's
//     collaborations. The decision names the repository with the smallest id
//     (Decision.RepoID): an epoch of that repository re-checks it, which then
//     finds another one if there is any.
//
// The units are the base bit only: every entity of the group is UnitNone.

// ownerUnits are the repository units whose readers may read the owner's
// group: issues or pull requests.
const ownerUnits = unitIssues | unitPulls

// ownerVisible reports whether viewer may read owner's own group, org:{id}
// or profile:{id} (member: the viewer is a member of the organization).
func ownerVisible(ctx context.Context, owner, viewer *user_model.User, member bool) bool {
	if owner.IsOrganization() {
		// organization.HasOrgOrUserVisible for a signed-in viewer.
		return viewer.IsAdmin || owner.ID == viewer.ID ||
			!((owner.Visibility == structs.VisibleTypePrivate || viewer.IsRestricted) && !member)
	}
	return profileVisible(ctx, owner, viewer)
}

// checkOwner decides owner:{id} on demand (see the comment above).
func checkOwner(ctx context.Context, viewer *user_model.User, id int64) (Decision, bool, error) {
	owner, ok, err := lookupUser(ctx, id)
	if err != nil || !ok {
		return Decision{}, false, err
	}
	d := Decision{Units: unitBase, Basis: Basis{}}
	d.Basis.addUser(&owner)
	member := false
	if owner.IsOrganization() {
		if member, err = org_model.IsOrganizationMember(ctx, id, viewer.ID); err != nil {
			return Decision{}, false, fmt.Errorf("livesync: check owner:%d: %w", id, err)
		}
	}
	if ownerVisible(ctx, &owner, viewer, member) {
		return d, true, nil
	}
	var repoIDs []int64
	if err := db.GetEngine(ctx).Table("repository").Cols("id").
		Where(collaborationsOf(viewer.ID, []int64{id})).OrderBy("id").Find(&repoIDs); err != nil {
		return Decision{}, false, fmt.Errorf("livesync: check owner:%d: %w", id, err)
	}
	for _, repoID := range repoIDs {
		repo, err := repo_model.GetRepositoryByID(ctx, repoID)
		if repo_model.IsErrRepoNotExist(err) {
			continue
		} else if err != nil {
			return Decision{}, false, fmt.Errorf("livesync: check owner:%d: %w", id, err)
		}
		rd, ok, err := checkRepo(ctx, viewer, repo)
		if err != nil {
			return Decision{}, false, err
		}
		if ok && rd.Units&ownerUnits != 0 {
			return Decision{Units: unitBase, RepoID: repoID, Basis: rd.Basis}, true, nil
		}
	}
	return d, false, nil
}

// collaborationsOf selects the repositories of owners on which viewerID is
// a collaborator.
func collaborationsOf(viewerID int64, owners []int64) builder.Cond {
	return builder.In("owner_id", owners).And(
		builder.In("id", builder.Select("repo_id").From("collaboration").Where(builder.Eq{"user_id": viewerID})))
}

// checkOwners decides the owner:{id} groups of ids for checkGroups, with a
// fixed number of queries: users holds the owners' rows, member the
// viewer's memberships among them; in returns the viewer's inputs (loaded
// once, when a repository has to decide).
func checkOwners(ctx context.Context, viewer *user_model.User, ids []int64, users map[int64]*user_model.User,
	member map[int64]bool, in func() (*viewerInputs, error), add func(string, Decision),
) error {
	var hidden []int64
	for _, id := range ids {
		owner := users[id]
		if owner == nil {
			continue
		}
		if ownerVisible(ctx, owner, viewer, member[id]) {
			d := Decision{Units: unitBase, Basis: Basis{}}
			d.Basis.addUser(owner)
			add(protocol.OwnerGroup(id), d)
			continue
		}
		hidden = append(hidden, id)
	}
	if len(hidden) == 0 {
		return nil
	}
	var repos []*repo_model.Repository
	for start := 0; start < len(hidden); start += inChunk {
		var chunk []*repo_model.Repository
		if err := db.GetEngine(ctx).Where(collaborationsOf(viewer.ID, hidden[start:min(start+inChunk, len(hidden))])).
			OrderBy("id").Find(&chunk); err != nil {
			return fmt.Errorf("livesync: check owners: %w", err)
		}
		repos = append(repos, chunk...)
	}
	if len(repos) == 0 {
		return nil
	}
	inputs, err := in()
	if err != nil {
		return err
	}
	decided := map[int64]bool{}
	for start := 0; start < len(repos); start += inChunk {
		chunk := repos[start:min(start+inChunk, len(repos))]
		repoIDs := make([]int64, 0, len(chunk))
		for _, r := range chunk {
			repoIDs = append(repoIDs, r.ID)
		}
		if err := loadOwners(ctx, chunk); err != nil {
			return err
		}
		units, err := loadRepoUnits(ctx, repoIDs)
		if err != nil {
			return err
		}
		for _, repo := range chunk { // ordered by id: the smallest decides
			if decided[repo.OwnerID] || repo.Owner == nil {
				continue
			}
			p := inputs.repoPermission(viewer, repo, units[repo.ID])
			if !p.HasAccess() || repoUnits(&p)&ownerUnits == 0 {
				continue
			}
			decided[repo.OwnerID] = true
			d := Decision{Units: unitBase, RepoID: repo.ID, Basis: Basis{}}
			d.Basis.addRepo(repo)
			d.Basis.addUser(repo.Owner)
			add(protocol.OwnerGroup(repo.OwnerID), d)
		}
	}
	return nil
}
