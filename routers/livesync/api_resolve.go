// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

package livesync

import (
	"net/http"

	issues_model "forgejo.org/models/issues"
	"forgejo.org/services/livesync/protocol"
)

// Resolving a review conversation (protocol/api.go): the classic Files tab's
// Resolve / Unresolve (UpdateResolveConversation, routers/web/repo/
// pull_review.go: issues_model.MarkConversation, with the checks of
// issues_model.CanMarkConversation). API v1 has no endpoint for it.

// apiCommentResolved answers PUT /-/sync/api/comments/{id}/resolved.
func apiCommentResolved(w http.ResponseWriter, req *http.Request) {
	a := apiAuth(w, req, bodyWriteScope)
	if a == nil {
		return
	}
	id, ok := a.id("id")
	if !ok {
		return
	}
	var body protocol.APICommentResolved
	if !a.decode(&body) {
		return
	}
	comment, err := issues_model.GetCommentByID(a.ctx, id)
	if err != nil {
		if issues_model.IsErrCommentNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the comment", err)
		}
		return
	}
	issue, err := issues_model.GetIssueByID(a.ctx, comment.IssueID)
	if err != nil {
		if issues_model.IsErrIssueNotExist(err) {
			a.notFound()
		} else {
			a.internal("load the issue", err)
		}
		return
	}
	repo, perm, ok := a.repoPermission(issue.RepoID)
	if !ok {
		return
	}
	issue.Repo = repo
	if !canReadIssue(perm, issue) {
		a.notFound()
		return
	}
	// Another user's draft (a comment of a pending review) is not readable: 404, as for one that does not exist.
	if err := comment.LoadReview(a.ctx); err != nil {
		a.internal("load the comment's review", err)
		return
	}
	if comment.Review != nil && comment.Review.Type == issues_model.ReviewTypePending && comment.PosterID != a.viewer.ID {
		a.notFound()
		return
	}
	if !issue.IsPull || comment.Type != issues_model.CommentTypeCode {
		a.error(http.StatusUnprocessableEntity, "only a code comment of a pull request starts a conversation")
		return
	}
	can, err := issues_model.CanMarkConversation(a.ctx, issue, a.viewer)
	if err != nil {
		a.internal("check the permission", err)
		return
	}
	if !can {
		a.forbidden()
		return
	}
	if repo.IsArchived {
		a.error(http.StatusForbidden, "the repository is archived")
		return
	}
	if err := issues_model.MarkConversation(a.ctx, comment, a.viewer, body.Resolved); err != nil {
		a.internal("mark the conversation", err)
		return
	}
	a.noContent()
}
