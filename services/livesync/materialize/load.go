// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package materialize

import (
	"bytes"
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
	// to no group (e.g. an attachment not linked to anything yet, a draft
	// release), which is handled like a deleted row.
	group string
	unit  protocol.Unit
	// perm is the row's permission state (main entity of a spec with a
	// perm hook only; see perm.go).
	perm string
	// dto is the payload, built only when the materializer emits (not for
	// the entity index backfill). Its rendered markdown fields are filled
	// only once the entity is emitted (renders).
	dto any
	// renders are the markdown fields of dto still to be rendered.
	renders []pendingRender
	// encoded is dto's JSON once encoded.
	encoded []byte
	// err is set when the DTO could not be built (bad data in the row):
	// the entity is skipped, logged, and left as it was, so that one bad
	// row cannot stall the sync log.
	err error
}

// pendingRender is a markdown field of a DTO to render on emission.
type pendingRender struct {
	repo    *repo_model.Repository
	content string
	dst     *string
}

// changeHash returns the hash that is compared with the entity index to tell
// whether anything visible changed (livesync_entity.hash). For a DTO without
// markdown it is the hash of the payload. Rendering markdown is expensive
// (goldmark, git lookups, user lookups — inside the writer's transaction),
// and an issue row changes for many reasons that leave its body alone (every
// comment touches updated_unix), so for a DTO with markdown fields it is the
// hash of the payload without the rendered HTML plus the rendering
// environment (each repository's link and markup metas): the HTML is a
// function of those (the raw source is in the payload), and the body is
// rendered only when that hash changes.
func (e *entity) changeHash(ctx context.Context, l *loader) (string, error) {
	b, err := marshal(e.dto)
	if err != nil {
		return "", fmt.Errorf("livesync: encode %s: %w", e.model, err)
	}
	h := fnv.New64a()
	_, _ = h.Write(b)
	if len(e.renders) == 0 {
		e.encoded = b
	}
	for _, r := range e.renders {
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(l.renderEnv(ctx, r.repo)))
	}
	return strconv.FormatUint(h.Sum64(), 16), nil
}

// payload renders the entity's markdown fields and returns its JSON. Call
// changeHash first.
func (e *entity) payload(ctx context.Context, l *loader) (string, error) {
	if len(e.renders) > 0 {
		for _, r := range e.renders {
			*r.dst = l.renderMarkdown(ctx, r.repo, r.content)
		}
		e.renders = nil
		b, err := marshal(e.dto)
		if err != nil {
			return "", fmt.Errorf("livesync: encode %s: %w", e.model, err)
		}
		e.encoded = b
	}
	return string(e.encoded), nil
}

// marshal encodes a payload as JSON without HTML escaping: payloads are
// parsed as JSON by the client and never inlined into HTML, and escaping
// every <, > and & of rendered HTML as \u003c… makes body_html much larger in
// the log and on the wire.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	if e, ok := enc.(interface{ SetEscapeHTML(bool) }); ok {
		e.SetEscapeHTML(false)
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
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
// requests, comments, reviews, releases) that the rows of one batch need to
// find their group and unit, or to render markdown, so that each is read
// once per batch.
type loader struct {
	issues   map[int64]*issues_model.Issue
	repos    map[int64]*repo_model.Repository
	projects map[int64]*project_model.Project
	pulls    map[int64]*issues_model.PullRequest
	comments map[int64]*issues_model.Comment
	reviews  map[int64]*issues_model.Review
	releases map[int64]*repo_model.Release
	// gitRepos are the git repositories opened for rendering (nil when
	// one could not be opened); close releases them.
	gitRepos map[int64]*git.Repository
	// envs caches renderEnv per repository.
	envs map[int64]string
	// pending collects the markdown fields a DTO builder asked for (see
	// markdown); the spec moves them to the DTO's entity.
	pending []pendingRender
}

func newLoader() *loader {
	return &loader{
		issues:   map[int64]*issues_model.Issue{},
		repos:    map[int64]*repo_model.Repository{},
		projects: map[int64]*project_model.Project{},
		pulls:    map[int64]*issues_model.PullRequest{},
		comments: map[int64]*issues_model.Comment{},
		reviews:  map[int64]*issues_model.Review{},
		releases: map[int64]*repo_model.Release{},
		gitRepos: map[int64]*git.Repository{},
		envs:     map[int64]string{},
	}
}

// markdown asks for content to be rendered into *dst when the DTO being
// built is emitted (see entity.changeHash).
func (l *loader) markdown(repo *repo_model.Repository, content string, dst *string) {
	l.pending = append(l.pending, pendingRender{repo: repo, content: content, dst: dst})
}

// takeRenders returns and clears the renders asked for since the last call.
func (l *loader) takeRenders() []pendingRender {
	res := l.pending
	l.pending = nil
	return res
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

func (l *loader) loadReviews(ctx context.Context, ids []int64) error {
	return fill(ctx, l.reviews, ids, func(r *issues_model.Review) int64 { return r.ID })
}

func (l *loader) loadReleases(ctx context.Context, ids []int64) error {
	return fill(ctx, l.releases, ids, func(r *repo_model.Release) int64 { return r.ID })
}

// loadCommentParents loads what commentPlace needs for comments: their
// issues and the reviews they belong to.
func (l *loader) loadCommentParents(ctx context.Context, comments []*issues_model.Comment) error {
	issueIDs := make([]int64, 0, len(comments))
	reviewIDs := make([]int64, 0, len(comments))
	for _, c := range comments {
		l.comments[c.ID] = c
		issueIDs = append(issueIDs, c.IssueID)
		reviewIDs = append(reviewIDs, c.ReviewID)
	}
	if err := l.loadIssues(ctx, issueIDs); err != nil {
		return err
	}
	return l.loadReviews(ctx, reviewIDs)
}

// loadComments loads comments by id, with what commentPlace needs.
func (l *loader) loadComments(ctx context.Context, ids []int64) error {
	if err := fill(ctx, l.comments, ids, func(c *issues_model.Comment) int64 { return c.ID }); err != nil {
		return err
	}
	list := make([]*issues_model.Comment, 0, len(ids))
	for _, id := range ids {
		if c := l.comments[id]; c != nil {
			list = append(list, c)
		}
	}
	return l.loadCommentParents(ctx, list)
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

// projectPlace is the group and unit of a project and its columns: the
// repository's (unit projects) for a repository project, the organization's
// group for an organization's, the profile group of the user for a user's
// (what anyone who may see the user reads).
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
		return protocol.ProfileGroup(p.OwnerID), protocol.UnitNone
	}
	return "", protocol.UnitNone
}

// reviewPlace is the group and unit of a review. A pending review is a draft
// that upstream shows to its reviewer only (models/issues/comment_code.go
// drops a pending review's comments for anyone else; API v1 answers 404 for
// another user's pending review), so it belongs to the reviewer's own
// entities until it is submitted; submitting moves it (and, through
// dependents, its comments and their attachments) to issue:{id}.
func (l *loader) reviewPlace(r *issues_model.Review) (string, protocol.Unit) {
	group, _ := l.issuePlace(r.IssueID)
	switch {
	case group == "":
		return "", protocol.UnitNone
	case r.Type == issues_model.ReviewTypePending:
		if r.ReviewerID <= 0 {
			return "", protocol.UnitNone
		}
		return protocol.UserGroup(r.ReviewerID), protocol.UnitSelf
	}
	return group, protocol.UnitPulls
}

// commentPlace is the group and unit of a comment, and of what hangs off it
// (attachments, reactions, revisions):
//   - a code comment of a pending review: the review's (the reviewer's own);
//   - a cross-reference from another repository (an issue, pull request or
//     comment of repository P mentioned this issue): no group. Upstream
//     shows it only to viewers who can read P's issues or pulls
//     (routers/web/repo/issue.go filterXRefComments, and API v1), which a
//     group plus a unit of this issue's repository cannot express;
//   - anything else: issue:{id}.
func (l *loader) commentPlace(c *issues_model.Comment) (string, protocol.Unit) {
	if c.ReviewID != 0 {
		if r := l.reviews[c.ReviewID]; r != nil && r.Type == issues_model.ReviewTypePending {
			return l.reviewPlace(r)
		}
	}
	if issues_model.CommentTypeIsRef(c.Type) && c.RefRepoID != 0 {
		if issue := l.issues[c.IssueID]; issue != nil && c.RefRepoID != issue.RepoID {
			return "", protocol.UnitNone
		}
	}
	return l.issuePlace(c.IssueID)
}

// commentChildPlace is the group and unit of a row that belongs to an issue
// and, if commentID is not 0, to one of its comments (loadComments).
func (l *loader) commentChildPlace(issueID, commentID int64) (string, protocol.Unit) {
	if commentID == 0 {
		return l.issuePlace(issueID)
	}
	if c := l.comments[commentID]; c != nil {
		return l.commentPlace(c)
	}
	return "", protocol.UnitNone // the comment is gone
}

// releasePlace is the group and unit of a release and its attachments. A
// draft is shown by upstream to writers only (API v1 answers 404 and the
// list leaves drafts out for readers), which a unit cannot express, so it
// belongs to no group until it is published. A tag without a release
// (is_tag) is not a release for upstream (API v1's release routes answer
// 404 for it and the list leaves it out): it is a git tag, which API v1
// serves to code readers (/tags), so it needs the code unit (B6: found by
// the bootstrap differential test).
func releasePlace(r *repo_model.Release) (string, protocol.Unit) {
	switch {
	case r == nil || r.IsDraft:
		return "", protocol.UnitNone
	case r.IsTag:
		return protocol.RepoGroup(r.RepoID), protocol.UnitCode
	}
	return protocol.RepoGroup(r.RepoID), protocol.UnitReleases
}
