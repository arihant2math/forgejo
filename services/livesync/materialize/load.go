// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"context"
	"fmt"
	"hash/fnv"
	"strconv"

	"forgejo.org/models/db"
	issues_model "forgejo.org/models/issues"
	project_model "forgejo.org/models/project"
	repo_model "forgejo.org/models/repo"
	"forgejo.org/modules/git"
	"forgejo.org/modules/json"
	project_module "forgejo.org/modules/project"
	"forgejo.org/services/livesync/protocol"
)

// entity is the materialized state of one entity of a row.
type entity struct {
	// key is the livesync_entity.tbl of the entity: the table for a row's
	// main entity, "<table>#<suffix>" for a derived one.
	key    string
	model  protocol.Model
	schema int
	// group is the entity's sync group; "" means the row currently belongs
	// to no group (e.g. an attachment not linked to anything yet), which is
	// handled like a deleted row.
	group string
	unit  protocol.Unit
	// dto is the payload, built only when the materializer emits (not for
	// the entity index backfill).
	dto any
	// err is set when the DTO could not be built (bad data in the row):
	// the entity is skipped, logged, and left as it was, so that one bad
	// row cannot stall the sync log.
	err error
}

// payload encodes the entity's DTO and hashes it.
func (e *entity) payload() (string, string, error) {
	b, err := json.Marshal(e.dto)
	if err != nil {
		return "", "", fmt.Errorf("livesync: encode %s: %w", e.model, err)
	}
	h := fnv.New64a()
	_, _ = h.Write(b)
	return string(b), strconv.FormatUint(h.Sum64(), 16), nil
}

// inChunk bounds the ids of one IN (...) list.
const inChunk = 500

// findByIDs loads the rows of T's table with the given ids through
// Forgejo's typed model (so an upstream model change is a compile error
// here, PLAN §4.4), keyed by id. Missing ids are absent from the map.
func findByIDs[T any](ctx context.Context, ids []int64, id func(*T) int64) (map[int64]*T, error) {
	res := make(map[int64]*T, len(ids))
	for start := 0; start < len(ids); start += inChunk {
		chunk := ids[start:min(start+inChunk, len(ids))]
		rows := make([]*T, 0, len(chunk))
		if err := db.GetEngine(ctx).In("id", chunk).Find(&rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			res[id(r)] = r
		}
	}
	return res, nil
}

// loader caches the parent rows (issues, repositories, projects, pull
// requests) that the rows of one batch need to find their group and unit,
// or to render markdown, so that each is read once per batch.
type loader struct {
	issues   map[int64]*issues_model.Issue
	repos    map[int64]*repo_model.Repository
	projects map[int64]*project_model.Project
	pulls    map[int64]*issues_model.PullRequest
	// gitRepos are the git repositories opened for rendering (nil when
	// one could not be opened); close releases them.
	gitRepos map[int64]*git.Repository
}

func newLoader() *loader {
	return &loader{
		issues:   map[int64]*issues_model.Issue{},
		repos:    map[int64]*repo_model.Repository{},
		projects: map[int64]*project_model.Project{},
		pulls:    map[int64]*issues_model.PullRequest{},
		gitRepos: map[int64]*git.Repository{},
	}
}

// missing returns the ids not yet in cache (deduplicated, non-zero).
func missing[T any](cache map[int64]*T, ids []int64) []int64 {
	var res []int64
	seen := map[int64]bool{}
	for _, id := range ids {
		if _, ok := cache[id]; !ok && id != 0 && !seen[id] {
			seen[id] = true
			res = append(res, id)
		}
	}
	return res
}

// fill loads the missing ids into cache; ids that do not exist are cached
// as nil so they are not looked up again.
func fill[T any](ctx context.Context, cache map[int64]*T, ids []int64, id func(*T) int64) error {
	ids = missing(cache, ids)
	if len(ids) == 0 {
		return nil
	}
	rows, err := findByIDs(ctx, ids, id)
	if err != nil {
		return err
	}
	for _, i := range ids {
		cache[i] = rows[i]
	}
	return nil
}

func (l *loader) loadIssues(ctx context.Context, ids []int64) error {
	return fill(ctx, l.issues, ids, func(i *issues_model.Issue) int64 { return i.ID })
}

func (l *loader) loadRepos(ctx context.Context, ids []int64) error {
	return fill(ctx, l.repos, ids, func(r *repo_model.Repository) int64 { return r.ID })
}

func (l *loader) loadProjects(ctx context.Context, ids []int64) error {
	return fill(ctx, l.projects, ids, func(p *project_model.Project) int64 { return p.ID })
}

func (l *loader) loadPulls(ctx context.Context, ids []int64) error {
	return fill(ctx, l.pulls, ids, func(p *issues_model.PullRequest) int64 { return p.ID })
}

// issueUnit is the unit gating an issue's entities.
func issueUnit(issue *issues_model.Issue) protocol.Unit {
	if issue.IsPull {
		return protocol.UnitPulls
	}
	return protocol.UnitIssues
}

// issuePlace is the group and unit of a lazy-tier entity of an issue
// (group issue:{id}); no group if the issue does not exist (any more).
func (l *loader) issuePlace(issueID int64) (string, protocol.Unit) {
	issue := l.issues[issueID]
	if issue == nil {
		return "", protocol.UnitNone
	}
	return protocol.IssueGroup(issue.ID), issueUnit(issue)
}

// issueRepoPlace is the group and unit of a summary-tier entity attached to
// an issue (group repo:{repo_id}).
func (l *loader) issueRepoPlace(issueID int64) (string, protocol.Unit) {
	issue := l.issues[issueID]
	if issue == nil {
		return "", protocol.UnitNone
	}
	return protocol.RepoGroup(issue.RepoID), issueUnit(issue)
}

// projectPlace is the group and unit of a project's entities: the
// repository's (unit projects) for a repository project, else the owner's.
func (l *loader) projectPlace(projectID int64) (string, protocol.Unit) {
	p := l.projects[projectID]
	switch {
	case p == nil:
		return "", protocol.UnitNone
	case p.RepoID != 0:
		return protocol.RepoGroup(p.RepoID), protocol.UnitProjects
	case p.Type == project_module.TypeOrganization:
		return protocol.OrgGroup(p.OwnerID), protocol.UnitNone
	case p.OwnerID != 0:
		return protocol.UserGroup(p.OwnerID), protocol.UnitNone
	}
	return "", protocol.UnitNone
}
